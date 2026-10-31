import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ModuleLogger } from '@stagewise/logger';

import type { EpisodeFeed } from '@/session/chat/extensions/memory';
import { DEFAULT_SESSION_ID } from '@/session/types';
import {
  createSkillRegistry,
  type SkillRegistry,
  serializeSkill,
} from '@/skills';

import type { ExtensionDeps } from '../extension-api';
import { createLearningExt, LEARNING_EXTENSION_ID } from './learning';
import { createLearningState, type SkillState } from './learning-state';

vi.mock('./extraction-prompt.md', () => ({ default: 'Extract.' }));
vi.mock('./consolidation-prompt.md', () => ({ default: 'Consolidate.' }));

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

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as ModuleLogger;

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

interface Fixture {
  /** Extension data directory holding the legacy `skills/` folder and state. */
  dataDir: string;
  registry: SkillRegistry;
}

async function fixture(legacyNames: string[]): Promise<Fixture> {
  const dataDir = await temporaryDirectory('klex-learning-ext-');
  for (const name of legacyNames) await writeLegacySkill(dataDir, name);
  const registry = createSkillRegistry({
    dataDirectory: await temporaryDirectory('klex-learning-registry-'),
    logger,
  });
  await registry.start();
  registry.claimNamespace(LEARNING_EXTENSION_ID, 'learning');
  return { dataDir, registry };
}

async function writeLegacySkill(dataDir: string, name: string): Promise<void> {
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

function legacyUsage(overrides: Partial<SkillState> = {}): SkillState {
  return {
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-02-01T00:00:00.000Z',
    lastReadAt: '2025-03-01T00:00:00.000Z',
    readCount: 4,
    sourceEpisodes: ['2025-01-01/1-00-00.jsonl'],
    createdEpisode: 1,
    updatedEpisode: 2,
    lastReadEpisode: 3,
    ...overrides,
  };
}

async function seedLegacyState(
  dataDir: string,
  skills: Record<string, SkillState>,
): Promise<void> {
  const state = createLearningState(dataDir);
  await state.start();
  await state.update((draft) => {
    draft.cursor = 'cursor-1';
    draft.skills = skills;
  });
}

function fakeDeps(
  { dataDir, registry }: Fixture,
  sessionId: string,
  withSkills = true,
): ExtensionDeps {
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
    skills: withSkills ? registry.forNamespace('learning') : null,
  } as unknown as ExtensionDeps;
}

function factory() {
  return createLearningExt({
    getSoul: () => null,
    episodes: createEpisodeFeed(),
  });
}

async function startOnce(
  target: Fixture,
  sessionId = DEFAULT_SESSION_ID,
): Promise<void> {
  const extension = factory().create(fakeDeps(target, sessionId));
  await extension.onStart?.();
  await extension.onClose?.();
}

describe('learning extension', () => {
  it('declares the learning skill namespace', () => {
    expect(factory().skillNamespace).toBe('learning');
  });

  it('imports legacy skills with their bookkeeping into the learning namespace', async () => {
    const target = await fixture(['ask-first', 'cite-sources']);
    await seedLegacyState(target.dataDir, {
      'ask-first': legacyUsage({ userEdited: true }),
    });

    await startOnce(target);

    expect(target.registry.list().map((skill) => skill.id)).toEqual([
      'learning/ask-first',
      'learning/cite-sources',
    ]);
    expect(target.registry.get('learning/ask-first')).toMatchObject({
      namespace: 'learning',
      description: 'Use when ask-first applies.',
      body: 'Do ask-first.',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-02-01T00:00:00.000Z',
      lastReadAt: '2025-03-01T00:00:00.000Z',
      readCount: 4,
      userEdited: true,
      metadata: { sourceEpisodes: ['2025-01-01/1-00-00.jsonl'] },
    });
    // No legacy bookkeeping: fresh usage, no namespace metadata.
    expect(target.registry.get('learning/cite-sources')).toMatchObject({
      readCount: 0,
      lastReadAt: null,
      userEdited: false,
      metadata: {},
    });
    await expect(readdir(target.dataDir)).resolves.not.toContain('skills');

    const state = createLearningState(target.dataDir);
    await state.start();
    expect(state.get()).toMatchObject({ cursor: 'cursor-1', skills: {} });
  });

  it('is idempotent across restarts and does not reseed existing skills', async () => {
    const target = await fixture(['ask-first']);
    await seedLegacyState(target.dataDir, { 'ask-first': legacyUsage() });
    await startOnce(target);
    await target.registry.recordRead('learning/ask-first');
    const before = target.registry.get('learning/ask-first');

    await startOnce(target);

    expect(target.registry.get('learning/ask-first')).toEqual(before);
    expect(before?.readCount).toBe(5);
  });

  it('recovers from a crash between the registry write and the folder removal', async () => {
    const target = await fixture(['ask-first']);
    await seedLegacyState(target.dataDir, { 'ask-first': legacyUsage() });
    // State after a crash: imported into the registry, legacy folder and usage left behind.
    await target.registry
      .forNamespace('learning')
      .put(
        'ask-first',
        { description: 'Use when ask-first applies.', body: 'Do ask-first.' },
        { seed: { readCount: 4 } },
      );
    await target.registry.recordRead('learning/ask-first');
    const imported = target.registry.get('learning/ask-first');

    await startOnce(target);

    expect(target.registry.list()).toHaveLength(1);
    expect(target.registry.get('learning/ask-first')).toMatchObject({
      readCount: 5,
      updatedAt: imported?.updatedAt,
      updatedTurn: imported?.updatedTurn,
    });
    await expect(readdir(target.dataDir)).resolves.not.toContain('skills');
  });

  it('keeps unimportable legacy folders and their bookkeeping for a later retry', async () => {
    const target = await fixture(['ask-first']);
    const broken = join(target.dataDir, 'skills', 'broken');
    await mkdir(broken, { recursive: true });
    await writeFile(join(broken, 'SKILL.md'), 'not a skill');
    await seedLegacyState(target.dataDir, {
      'ask-first': legacyUsage(),
      broken: legacyUsage(),
    });

    await startOnce(target);

    expect(target.registry.list().map((skill) => skill.id)).toEqual([
      'learning/ask-first',
    ]);
    await expect(readdir(join(target.dataDir, 'skills'))).resolves.toEqual([
      'broken',
    ]);
    const state = createLearningState(target.dataDir);
    await state.start();
    expect(Object.keys(state.get().skills)).toEqual(['broken']);
  });

  it('imports only from the first default session', async () => {
    const target = await fixture(['ask-first']);
    const learning = factory();

    const background = learning.create(fakeDeps(target, 'background-1'));
    await background.onStart?.();
    expect(target.registry.list()).toEqual([]);

    const owner = learning.create(fakeDeps(target, DEFAULT_SESSION_ID));
    await owner.onStart?.();
    expect(target.registry.list()).toHaveLength(1);

    const second = learning.create(fakeDeps(target, DEFAULT_SESSION_ID));
    await second.onStart?.();
    expect(second.introspect?.()).toMatchObject({
      worker: 'not owned by this session',
    });
    expect(owner.introspect?.()).toMatchObject({ skillCount: 1 });

    await second.onClose?.();
    await owner.onClose?.();
    await background.onClose?.();
  });

  it('exposes no prompt part or tools; the skills extension owns them', async () => {
    const target = await fixture([]);
    const extension = factory().create(fakeDeps(target, DEFAULT_SESSION_ID));
    await extension.onStart?.();
    expect(extension.getSystemPromptPart).toBeUndefined();
    expect(extension.getTools).toBeUndefined();
    await extension.onClose?.();
  });

  it('fails to start the worker without a skill registry handle', async () => {
    const target = await fixture([]);
    const extension = factory().create(
      fakeDeps(target, DEFAULT_SESSION_ID, false),
    );
    await expect(extension.onStart?.()).rejects.toThrow(
      'requires the skill registry handle',
    );
    await extension.onClose?.();
  });
});
