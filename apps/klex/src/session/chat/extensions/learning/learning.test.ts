import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EpisodeFeed } from '@/session/chat/extensions/memory';
import { DEFAULT_SESSION_ID } from '@/session/types';

import type { Extension, ExtensionDeps } from '../extension-api';
import { createLearningExt } from './learning';
import {
  createSkillCatalog,
  SkillValidationError,
  serializeSkill,
} from './skill-store';

vi.mock('@/session/chat/extensions/time/system-prompt.md', () => ({
  default: '',
}));

vi.mock('./extraction-prompt.md', () => ({ default: 'Extract.' }));
vi.mock('./consolidation-prompt.md', () => ({ default: 'Consolidate.' }));
vi.mock('./system-prompt-part.md', () => ({ default: '## Learned skills\n' }));

/** Memory not ready: the worker idles, which keeps these tests model-free. */
function createEpisodeFeed(): EpisodeFeed {
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

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function seededDataDir(names: string[]): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), 'klex-learning-ext-'));
  directories.push(dataDir);
  for (const name of names) {
    const folder = join(dataDir, 'skills', name);
    await mkdir(folder, { recursive: true });
    await writeFile(
      join(folder, 'SKILL.md'),
      serializeSkill({
        name,
        description: `Use when ${name} applies.`,
        body: `Do ${name}.`,
      }),
    );
  }
  return dataDir;
}

function fakeDeps(dataDir: string, sessionId: string): ExtensionDeps {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return {
    sessionId,
    getDataDir: () => dataDir,
    logger,
    logging: { child: () => logger },
    config: {
      get: () => ({ officialName: 'Atlas' }),
      getModelSelection: () => ['test/model'],
    },
    createChildSession: vi.fn(),
  } as unknown as ExtensionDeps;
}

const MOCK_MODEL = {
  modelId: 'test:model',
  displayName: 'Test Model',
  contextSize: 128_000,
  inputCapabilities: {},
} as const;

async function readSkill(extension: Extension, name: string): Promise<unknown> {
  const tool = extension.getTools?.(MOCK_MODEL).readSkill as unknown as
    | { execute: (input: { name: string }) => Promise<unknown> }
    | undefined;
  if (!tool) throw new Error('readSkill tool missing');
  return tool.execute({ name });
}

describe('learning extension', () => {
  it('persists edits, preserves usage, and deletes without a tombstone', async () => {
    const dataDir = await seededDataDir(['ask-first', 'constructor']);
    const catalog = createSkillCatalog();
    const start = async () => {
      const extension = createLearningExt({
        getSoul: () => null,
        episodes: createEpisodeFeed(),
        skillCatalog: catalog,
      }).create(fakeDeps(dataDir, DEFAULT_SESSION_ID));
      await extension.onStart?.();
      return extension;
    };
    let extension = await start();
    await readSkill(extension, 'ask-first');
    await vi.waitFor(() =>
      expect(catalog.getUsage('ask-first')?.readCount).toBe(1),
    );
    const before = catalog.getUsage('ask-first');
    expect(
      await catalog.update('ask-first', { body: '  User instructions.  ' }),
    ).toMatchObject({
      body: 'User instructions.',
      description: 'Use when ask-first applies.',
    });
    expect(catalog.getUsage('ask-first')).toMatchObject({
      ...before,
      updatedAt: expect.any(String),
      userEdited: true,
    });
    expect(
      await catalog.update('constructor', {
        description: '  Restored skill.  ',
      }),
    ).toMatchObject({ description: 'Restored skill.' });
    expect(catalog.getUsage('constructor')).toMatchObject({
      userEdited: true,
      readCount: 0,
    });
    for (const patch of [
      { body: '' },
      { description: 'two\nlines' },
      { body: 'x'.repeat(4001) },
    ]) {
      await expect(catalog.update('ask-first', patch)).rejects.toBeInstanceOf(
        SkillValidationError,
      );
    }
    expect(await catalog.update('../escape', { body: 'x' })).toBeNull();
    expect(await catalog.update('missing', { body: 'x' })).toBeNull();
    await extension.onClose?.();
    extension = await start();
    expect(catalog.get('ask-first')?.body).toBe('User instructions.');
    expect(catalog.getUsage('ask-first')?.userEdited).toBe(true);
    expect(await catalog.delete('ask-first')).toBe(true);
    expect(catalog.getUsage('ask-first')).toBeNull();
    expect(await catalog.delete('ask-first')).toBe(false);
    await extension.onClose?.();
    extension = await start();
    expect(catalog.get('ask-first')).toBeNull();
    await extension.onClose?.();
    expect(await catalog.update('constructor', { body: 'x' })).toBeNull();
    expect(await catalog.delete('constructor')).toBe(false);
  });

  it('does not overwrite skill file if state persistence fails during update', async () => {
    const dataDir = await seededDataDir(['ask-first']);
    const catalog = createSkillCatalog();
    const extension = createLearningExt({
      getSoul: () => null,
      episodes: createEpisodeFeed(),
      skillCatalog: catalog,
    }).create(fakeDeps(dataDir, DEFAULT_SESSION_ID));
    await extension.onStart?.();
    await rm(join(dataDir, 'state.json'), { force: true });
    await mkdir(join(dataDir, 'state.json'), { recursive: true });
    await expect(
      catalog.update('ask-first', { body: 'Unprotected edit.' }),
    ).rejects.toThrow();
    expect(catalog.get('ask-first')?.body).toBe('Do ask-first.');
    await rm(join(dataDir, 'state.json'), { recursive: true, force: true });
    await readSkill(extension, 'ask-first');
    await vi.waitFor(() =>
      expect(catalog.getUsage('ask-first')?.readCount).toBe(1),
    );
    await rm(join(dataDir, 'skills', 'ask-first', 'SKILL.md'), { force: true });
    await mkdir(join(dataDir, 'skills', 'ask-first', 'SKILL.md'), {
      recursive: true,
    });
    await expect(
      catalog.update('ask-first', { body: 'Failed disk write.' }),
    ).rejects.toThrow();
    expect(catalog.getUsage('ask-first')).toMatchObject({
      readCount: 1,
      userEdited: false,
    });
    await extension.onClose?.();
  });
  it('lets only the first default session own the worker and catalog', async () => {
    const dataDir = await seededDataDir(['ask-first']);
    const skillCatalog = createSkillCatalog();
    const factory = createLearningExt({
      getSoul: () => null,
      episodes: createEpisodeFeed(),
      skillCatalog,
    });

    const background = factory.create(fakeDeps(dataDir, 'background-1'));
    await background.onStart?.();
    expect(skillCatalog.isAvailable()).toBe(false);

    const owner = factory.create(fakeDeps(dataDir, DEFAULT_SESSION_ID));
    await owner.onStart?.();
    expect(skillCatalog.isAvailable()).toBe(true);
    expect(skillCatalog.list().map((skill) => skill.name)).toEqual([
      'ask-first',
    ]);

    const second = factory.create(fakeDeps(dataDir, DEFAULT_SESSION_ID));
    await second.onStart?.();
    expect(second.introspect?.()).toMatchObject({
      worker: 'not owned by this session',
    });
    await second.onClose?.();
    expect(skillCatalog.isAvailable()).toBe(true);

    await owner.onClose?.();
    expect(skillCatalog.isAvailable()).toBe(false);
    await background.onClose?.();
  });

  it('lists skills in the system prompt and serves them through readSkill', async () => {
    const dataDir = await seededDataDir(['ask-first', 'cite-sources']);
    const skillCatalog = createSkillCatalog();
    const extension = createLearningExt({
      getSoul: () => null,
      episodes: createEpisodeFeed(),
      skillCatalog,
    }).create(fakeDeps(dataDir, DEFAULT_SESSION_ID));
    await extension.onStart?.();

    const prompt = String(extension.getSystemPromptPart?.());
    expect(prompt).toContain('ask-first');
    expect(prompt).toContain('cite-sources');

    expect(await readSkill(extension, 'ask-first')).toContain('Do ask-first.');
    await vi.waitFor(() =>
      expect(skillCatalog.getUsage('ask-first')?.readCount).toBe(1),
    );

    const unknown = await readSkill(extension, 'nope');
    expect(unknown).toBe(
      'Unknown skill "nope". Available: ask-first, cite-sources',
    );
    await extension.onClose?.();
  });

  it('tracks reads of a restored constructor skill without inherited bookkeeping', async () => {
    const dataDir = await seededDataDir(['constructor']);
    const skillCatalog = createSkillCatalog();
    const extension = createLearningExt({
      getSoul: () => null,
      episodes: createEpisodeFeed(),
      skillCatalog,
    }).create(fakeDeps(dataDir, DEFAULT_SESSION_ID));
    await extension.onStart?.();
    try {
      expect(skillCatalog.getUsage('constructor')).toBeNull();
      expect(String(extension.getSystemPromptPart?.())).toContain(
        'constructor',
      );
      expect(await readSkill(extension, 'constructor')).toContain(
        'Do constructor.',
      );
      await vi.waitFor(() =>
        expect(skillCatalog.getUsage('constructor')).toMatchObject({
          readCount: 1,
          sourceEpisodes: [],
        }),
      );
    } finally {
      await extension.onClose?.();
    }
  });

  it('renders an empty list when nothing was learned', async () => {
    const dataDir = await seededDataDir([]);
    const extension = createLearningExt({
      getSoul: () => null,
      episodes: createEpisodeFeed(),
      skillCatalog: createSkillCatalog(),
    }).create(fakeDeps(dataDir, DEFAULT_SESSION_ID));
    await extension.onStart?.();
    expect(await readSkill(extension, 'x')).toBe(
      'Unknown skill "x". Available: (none)',
    );
    await extension.onClose?.();
  });
});
