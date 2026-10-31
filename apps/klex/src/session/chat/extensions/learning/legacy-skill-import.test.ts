import {
  cp,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLogger, type ModuleLogger } from '@stagewise/logger';

import { createLocalData } from '@/local-data';
import { KLEX_VERSION } from '@/release';
import type { EpisodeFeed } from '@/session/chat/extensions/memory';
import { DEFAULT_SESSION_ID } from '@/session/types';
import {
  createSkillRegistry,
  SKILL_REGISTRY_STORE_DEFINITION,
  type Skill,
} from '@/skills';

import type { ExtensionDeps } from '../extension-api';
import { createLearningExt, LEARNING_EXTENSION_ID } from './learning';
import { LEARNING_SKILL_NAMESPACE } from './learning-config';
import { LEARNING_STATE_STORE_DEFINITION } from './learning-state';

vi.mock('./extraction-prompt.md', () => ({ default: 'Extract.' }));
vi.mock('./consolidation-prompt.md', () => ({ default: 'Consolidate.' }));

/** Injects a crash between the registry write and the legacy folder removal, or a failing bookkeeping save. */
const injected = vi.hoisted(() => ({
  failRemoval: null as null | ((path: string) => boolean),
  failRegistrySave: false,
}));
vi.mock('@/local-data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/local-data')>();
  return {
    ...actual,
    writeJsonStoreDocument: (
      ...args: Parameters<typeof actual.writeJsonStoreDocument>
    ) => {
      if (injected.failRegistrySave && args[1].id === 'skill-registry') {
        return Promise.reject(new Error('injected bookkeeping failure'));
      }
      return actual.writeJsonStoreDocument(...args);
    },
  };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rm: (...args: Parameters<typeof actual.rm>) => {
      const [path] = args;
      if (injected.failRemoval?.(String(path))) {
        return Promise.reject(new Error('injected removal failure'));
      }
      return actual.rm(...args);
    },
  };
});

const fixtures = fileURLToPath(
  new URL(
    '../../../../local-data-migration-fixtures/learning-skills-v2/',
    import.meta.url,
  ),
);
const NOW = '2026-10-31T12:00:00.000Z';
const STORES = [
  LEARNING_STATE_STORE_DEFINITION,
  SKILL_REGISTRY_STORE_DEFINITION,
] as const;
const logging = createLogger({ name: 'legacy-skill-import' });
const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as ModuleLogger;
const directories: string[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});

afterEach(async () => {
  injected.failRemoval = null;
  injected.failRegistrySave = false;
  vi.mocked(logger.error).mockClear();
  vi.useRealTimers();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

const extensionDir = (agentDir: string) =>
  join(agentDir, 'extensions', LEARNING_EXTENSION_ID);
const legacyRoot = (agentDir: string) => join(extensionDir(agentDir), 'skills');
const statePath = (agentDir: string) =>
  join(agentDir, LEARNING_STATE_STORE_DEFINITION.relativePath);
const importedPath = (agentDir: string, name: string) =>
  join(agentDir, 'skills', LEARNING_SKILL_NAMESPACE, name, 'SKILL.md');
const fixtureSkill = (name: string) =>
  readFile(join(fixtures, 'skills', name, 'SKILL.md'));

/** Agent data directory holding the frozen pre-registry layout. */
async function seededAgent({
  withBroken = true,
}: {
  withBroken?: boolean;
} = {}): Promise<string> {
  const agentDir = await mkdtemp(join(tmpdir(), 'klex-legacy-import-'));
  directories.push(agentDir);
  await cp(join(fixtures, 'state.json'), statePath(agentDir));
  await cp(join(fixtures, 'skills'), legacyRoot(agentDir), {
    recursive: true,
    filter: (source) => withBroken || !source.includes('/broken'),
  });
  return agentDir;
}

function episodeFeed(): EpisodeFeed {
  return {
    isAvailable: () => false,
    subscribe: () => () => undefined,
    listNeighbors: async () => [],
    readPage: async () => null,
    search: async () => ({
      matches: [],
      nextOffset: null,
      scannedBytes: 0,
      truncated: false,
    }),
    listCompleted: async () => [],
    listLatestCompleted: async () => [],
    read: async () => null,
    compareIds: (left, right) => left.localeCompare(right),
  };
}

/**
 * One agent start: registered local-data startup, then the registry and the
 * default-session learning extension, then shutdown. Returns the skills the
 * registry exposed while running.
 */
async function startAgent(agentDir: string): Promise<readonly Skill[]> {
  const localData = createLocalData({
    logging,
    dataDirectory: agentDir,
    klexVersion: KLEX_VERSION,
    stores: STORES,
  });
  await localData.start();
  const registry = createSkillRegistry({ dataDirectory: agentDir, logger });
  try {
    await registry.start();
    registry.claimNamespace(LEARNING_EXTENSION_ID, LEARNING_SKILL_NAMESPACE);
    const extension = createLearningExt({
      getSoul: () => null,
      episodes: episodeFeed(),
    }).create({
      sessionId: DEFAULT_SESSION_ID,
      getDataDir: () => extensionDir(agentDir),
      logger,
      logging: { child: () => logger },
      config: {
        get: () => ({ officialName: 'Atlas' }),
        getModelSelection: () => ['test/model'],
      },
      createChildSession: vi.fn(),
      skills: registry.forNamespace(LEARNING_SKILL_NAMESPACE),
    } as unknown as ExtensionDeps);
    await extension.onStart?.();
    const skills = registry.list();
    await extension.onClose?.();
    return skills;
  } finally {
    await registry.close();
    await localData.close();
  }
}

/** Registry-owned skill that already exists before the import runs. */
async function seedCoreSkill(
  agentDir: string,
  body: string,
  { adminEdit = false } = {},
): Promise<void> {
  const registry = createSkillRegistry({ dataDirectory: agentDir, logger });
  await registry.start();
  registry.claimNamespace(LEARNING_EXTENSION_ID, LEARNING_SKILL_NAMESPACE);
  await registry.forNamespace(LEARNING_SKILL_NAMESPACE).put(
    'fix-build',
    {
      description: 'Use when the build fails after a dependency update.',
      body,
    },
    { metadata: { sourceEpisodes: ['episode-0003', 'episode-0017'] } },
  );
  if (adminEdit) await registry.update('learning/fix-build', { body });
  await registry.close();
}

async function snapshot(agentDir: string) {
  const entries = await readdir(agentDir, {
    recursive: true,
    withFileTypes: true,
  });
  return Object.fromEntries(
    await Promise.all(
      entries
        .filter((entry) => entry.isFile())
        .map(async (entry) => {
          const file = join(entry.parentPath, entry.name);
          return [
            relative(agentDir, file),
            {
              bytes: (await readFile(file)).toString('base64'),
              mtime: (await stat(file)).mtimeMs,
            },
          ];
        }),
    ),
  );
}

/** Store and skill files by relative path, content only. */
async function contents(agentDir: string) {
  const entries = await readdir(agentDir, {
    recursive: true,
    withFileTypes: true,
  });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(agentDir, join(entry.parentPath, entry.name)))
    .filter(
      (path) => path.startsWith('skills') || path.startsWith('extensions'),
    )
    .sort();
  return Object.fromEntries(
    await Promise.all(
      files.map(async (path) => [
        path,
        await readFile(join(agentDir, path), 'utf8'),
      ]),
    ),
  );
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );
const readJson = async (path: string) =>
  JSON.parse(await readFile(path, 'utf8'));

describe('legacy skill import through registered startup', () => {
  it('moves legacy skills into the learning namespace with their usage', async () => {
    const agentDir = await seededAgent();

    const skills = await startAgent(agentDir);

    expect(skills.map((skill) => skill.id)).toEqual([
      'learning/deploy-notes',
      'learning/fix-build',
      'learning/no-state',
    ]);
    for (const name of ['deploy-notes', 'fix-build', 'no-state']) {
      expect(await readFile(importedPath(agentDir, name))).toEqual(
        await fixtureSkill(name),
      );
      expect(await exists(join(legacyRoot(agentDir), name))).toBe(false);
    }
    expect(await readdir(legacyRoot(agentDir))).toEqual(['broken']);
    expect(await exists(importedPath(agentDir, 'broken'))).toBe(false);

    const byName = new Map(skills.map((skill) => [skill.name, skill]));
    expect(byName.get('fix-build')).toMatchObject({
      createdAt: '2026-09-01T08:00:00.000Z',
      updatedAt: '2026-10-02T12:30:00.000Z',
      lastReadAt: '2026-10-25T16:45:00.000Z',
      readCount: 7,
      userEdited: true,
      createdTurn: 0,
      updatedTurn: 0,
      lastReadTurn: 0,
      metadata: { sourceEpisodes: ['episode-0003', 'episode-0017'] },
    });
    expect(byName.get('deploy-notes')).toMatchObject({
      createdAt: '2026-09-10T10:00:00.000Z',
      lastReadAt: null,
      lastReadTurn: null,
      readCount: 0,
      userEdited: false,
      metadata: { sourceEpisodes: ['episode-0009'] },
    });
    expect(byName.get('no-state')).toMatchObject({
      createdAt: NOW,
      updatedAt: NOW,
      lastReadAt: null,
      readCount: 0,
      userEdited: false,
      createdTurn: 0,
      metadata: {},
    });

    const state = await readJson(statePath(agentDir));
    // Only the entry of the folder left in place survives, for its retry.
    expect(Object.keys(state.skills)).toEqual(['broken']);
    expect(state).toMatchObject({
      _klex: {
        store: 'learning-extension-state',
        schemaVersion: 2,
        compatibilityVersion: 3,
        minimumKlexVersion: '0.28.0',
        writtenByKlexVersion: KLEX_VERSION,
      },
      cursor: 'episode-0042',
      episodeFailures: { 'episode-0040': 1 },
      processedEpisodeCount: 42,
      deferred: [{ id: 'episode-0041', after: 'episode-0042', attempts: 1 }],
      futureField: { preserve: true },
    });
  });

  it('removes the legacy root and empties learning skills once nothing is left', async () => {
    const agentDir = await seededAgent({ withBroken: false });

    await startAgent(agentDir);

    expect(await exists(legacyRoot(agentDir))).toBe(false);
    expect((await readJson(statePath(agentDir))).skills).toEqual({});
  });

  it('rewrites nothing on the next start', async () => {
    const agentDir = await seededAgent();
    await startAgent(agentDir);
    const before = await snapshot(agentDir);

    vi.setSystemTime(new Date('2026-11-01T12:00:00.000Z'));
    await startAgent(agentDir);

    expect(await snapshot(agentDir)).toEqual(before);
  });

  it('converges to a clean run after a crash between registry write and folder removal', async () => {
    const clean = await seededAgent();
    await startAgent(clean);

    const crashed = await seededAgent();
    injected.failRemoval = (path) =>
      path === join(legacyRoot(crashed), 'fix-build');
    await startAgent(crashed);
    expect(await exists(join(legacyRoot(crashed), 'fix-build'))).toBe(true);
    expect(await exists(importedPath(crashed, 'fix-build'))).toBe(true);

    injected.failRemoval = null;
    const skills = await startAgent(crashed);

    expect(skills.filter((skill) => skill.name === 'fix-build')).toHaveLength(
      1,
    );
    expect(await contents(crashed)).toEqual(await contents(clean));
  });

  it('keeps legacy folders and usage until registry bookkeeping is on disk', async () => {
    const agentDir = await seededAgent();
    const stateBefore = await readJson(statePath(agentDir));
    vi.setSystemTime(new Date('2026-10-31T13:00:00.000Z'));
    injected.failRegistrySave = true;

    await startAgent(agentDir);

    for (const name of ['deploy-notes', 'fix-build', 'no-state']) {
      expect(await exists(join(legacyRoot(agentDir), name))).toBe(true);
      // The document itself was written before the bookkeeping failed.
      expect(await exists(importedPath(agentDir, name))).toBe(true);
    }
    // Entries of folders still in place survive; folderless ones are pruned.
    const { vanished: _vanished, ...kept } = stateBefore.skills;
    expect((await readJson(statePath(agentDir))).skills).toEqual(kept);
    // Learning writes would be overwritten by the next import.
    expect(logger.error).toHaveBeenCalledWith(
      { failed: 3 },
      'Some legacy skills were not imported; learning paused until next start',
    );

    injected.failRegistrySave = false;
    vi.mocked(logger.error).mockClear();
    vi.setSystemTime(new Date(NOW));
    const skills = await startAgent(agentDir);

    // Documents without persisted bookkeeping still take the legacy seed.
    expect(skills.find((skill) => skill.name === 'fix-build')).toMatchObject({
      createdAt: '2026-09-01T08:00:00.000Z',
      readCount: 7,
      userEdited: true,
      metadata: { sourceEpisodes: ['episode-0003', 'episode-0017'] },
    });
    expect(await exists(join(legacyRoot(agentDir), 'fix-build'))).toBe(false);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('prunes leftover usage when a crash already removed the legacy root', async () => {
    const agentDir = await seededAgent({ withBroken: false });
    await rm(legacyRoot(agentDir), { recursive: true });
    expect(
      Object.keys((await readJson(statePath(agentDir))).skills).length,
    ).toBeGreaterThan(0);

    await startAgent(agentDir);

    expect((await readJson(statePath(agentDir))).skills).toEqual({});
  });

  it('starts the session but pauses learning when the import throws', async () => {
    const agentDir = await seededAgent();
    await rm(legacyRoot(agentDir), { recursive: true });
    // readdir on a file fails with ENOTDIR.
    await writeFile(legacyRoot(agentDir), 'not a folder');
    const usage = (await readJson(statePath(agentDir))).skills;

    await expect(startAgent(agentDir)).resolves.toEqual([]);

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(Error) }),
      'Importing legacy skills failed; learning paused until next start',
    );
    expect(await readFile(legacyRoot(agentDir), 'utf8')).toBe('not a folder');
    expect((await readJson(statePath(agentDir))).skills).toEqual(usage);
  });

  it('leaves an identical pre-existing core skill untouched', async () => {
    const agentDir = await seededAgent();
    vi.setSystemTime(new Date('2026-10-30T08:00:00.000Z'));
    await seedCoreSkill(
      agentDir,
      '1. Read the first compiler error, not the last.\n2. Reinstall with the lockfile before changing code.',
    );
    const document = await stat(importedPath(agentDir, 'fix-build'));
    vi.setSystemTime(new Date(NOW));

    const skills = await startAgent(agentDir);

    expect((await stat(importedPath(agentDir, 'fix-build'))).mtimeMs).toBe(
      document.mtimeMs,
    );
    // Existing bookkeeping wins; the legacy seed applies only on create.
    expect(skills.find((skill) => skill.name === 'fix-build')).toMatchObject({
      createdAt: '2026-10-30T08:00:00.000Z',
      readCount: 0,
      userEdited: false,
    });
    expect(await exists(join(legacyRoot(agentDir), 'fix-build'))).toBe(false);
  });

  it('lets legacy content replace a different core skill as a namespace write', async () => {
    const agentDir = await seededAgent();
    vi.setSystemTime(new Date('2026-10-30T08:00:00.000Z'));
    await seedCoreSkill(agentDir, 'Edited by an admin.', { adminEdit: true });
    vi.setSystemTime(new Date(NOW));

    const skills = await startAgent(agentDir);

    expect(await readFile(importedPath(agentDir, 'fix-build'))).toEqual(
      await fixtureSkill('fix-build'),
    );
    expect(skills.find((skill) => skill.name === 'fix-build')).toMatchObject({
      createdAt: '2026-10-30T08:00:00.000Z',
      updatedAt: NOW,
      userEdited: false,
    });
  });

  it('serves imported skills to registry consumers by qualified and bare name', async () => {
    const agentDir = await seededAgent();
    await startAgent(agentDir);

    const registry = createSkillRegistry({ dataDirectory: agentDir, logger });
    await registry.start();
    try {
      expect(registry.list().map((skill) => skill.id)).toEqual([
        'learning/deploy-notes',
        'learning/fix-build',
        'learning/no-state',
      ]);
      expect(
        registry.resolveName('fix-build').map((skill) => skill.id),
      ).toEqual(['learning/fix-build']);
      expect(registry.read('learning/fix-build')).toBe(
        (await fixtureSkill('fix-build')).toString('utf8'),
      );
    } finally {
      await registry.close();
    }
  });
});

describe('learning-state compatibility floor', () => {
  const olderReader = {
    ...LEARNING_STATE_STORE_DEFINITION,
    compatibilityVersion: 2,
    minimumKlexVersion: '0.24.0',
  };

  it('makes an older reader refuse imported data before mutating it', async () => {
    const agentDir = await seededAgent();
    await startAgent(agentDir);
    const before = await snapshot(agentDir);

    await expect(
      createLocalData({
        logging,
        dataDirectory: agentDir,
        klexVersion: '0.27.1',
        stores: [olderReader, SKILL_REGISTRY_STORE_DEFINITION],
      }).start(),
    ).rejects.toThrow(
      /requires a newer read\/write compatibility level.*Use Klex 0\.28\.0 or newer/,
    );
    expect(await snapshot(agentDir)).toEqual(before);
  });

  it.each([
    [
      'invalid old data',
      /processedEpisodeCount/,
      (state: Record<string, unknown>) => ({
        ...state,
        processedEpisodeCount: -1,
      }),
    ],
    [
      'newer-schema data',
      /was migrated by a newer Klex version.*Use Klex 9\.0\.0 or newer/,
      (state: Record<string, unknown>) => ({
        ...state,
        _klex: {
          ...(state._klex as Record<string, unknown>),
          schemaVersion: 3,
          compatibilityVersion: 3,
          minimumKlexVersion: '9.0.0',
        },
      }),
    ],
  ])(
    'keeps %s and legacy skills byte-identical',
    async (_name, reason, mutate) => {
      const agentDir = await seededAgent();
      await writeFile(
        statePath(agentDir),
        `${JSON.stringify(mutate(await readJson(statePath(agentDir))), null, 2)}\n`,
      );
      const before = await snapshot(agentDir);

      await expect(startAgent(agentDir)).rejects.toThrow(reason);

      expect(await snapshot(agentDir)).toEqual(before);
    },
  );
});
