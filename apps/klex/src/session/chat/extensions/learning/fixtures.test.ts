import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ModuleLogger } from '@stagewise/logger';

import { createEpisodeFeed } from '@/session/chat/extensions/memory';

import type { GenerateTextArgs, GenerateTextResult } from '../extension-api';
import { createLearningState } from './learning-state';
import { createLearningWorker } from './learning-worker';
import { createSkillStore } from './skill-store';

// The real prompt text, so the test sees the sections the model sees.
vi.mock('./extraction-prompt.md', async () => {
  const { readFile: read } = await import('node:fs/promises');
  return {
    default: await read(
      new URL('./extraction-prompt.md', import.meta.url),
      'utf8',
    ),
  };
});
vi.mock('./consolidation-prompt.md', async () => {
  const { readFile: read } = await import('node:fs/promises');
  return {
    default: await read(
      new URL('./consolidation-prompt.md', import.meta.url),
      'utf8',
    ),
  };
});
vi.mock('./system-prompt-part.md', () => ({ default: '## Learned skills\n' }));
// Only the episode feed is real; the rest of the memory barrel pulls in the
// whole extension graph and its Markdown imports.
vi.mock('@/session/chat/extensions/memory/memory', () => ({
  createMemoryExt: vi.fn(),
}));
vi.mock('@/session/chat/extensions/memory/retrieval', () => ({
  EPISODIC_SEARCH_INDEX_STORE_DEFINITION: {},
}));
vi.mock('@/session/chat/extensions/time/system-prompt.md', () => ({
  default: '',
}));

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

/** Fixture file → episode id, in feed order. */
const EPISODES = [
  ['feedback.jsonl', '2026-10-01/1-09-00.jsonl'],
  ['fix-after-failure.jsonl', '2026-10-01/2-11-00.jsonl'],
  ['no-lesson.jsonl', '2026-10-01/3-15-00.jsonl'],
] as const;

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function ok(text: string): GenerateTextResult {
  return { success: true, text } as GenerateTextResult;
}

function reply(...operations: object[]): GenerateTextResult {
  return ok(JSON.stringify({ operations }));
}

async function recordLines(file: string): Promise<number> {
  const content = await readFile(join(FIXTURES, file), 'utf8');
  return content.split('\n').filter((line) => line.trim() !== '').length - 1;
}

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'klex-learning-fixtures-'));
  directories.push(root);
  const episodicDir = join(root, 'episodic');
  await mkdir(join(episodicDir, '2026-10-01'), { recursive: true });
  for (const [file, id] of EPISODES) {
    await copyFile(join(FIXTURES, file), join(episodicDir, id));
  }

  const episodes = createEpisodeFeed();
  episodes.attach({ episodicDir, getOpenEpisode: async () => null });

  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as ModuleLogger;
  const dataDir = join(root, 'learning');
  const store = createSkillStore(join(dataDir, 'skills'), logger);
  const state = createLearningState(dataDir);
  await Promise.all([store.start(), state.start()]);

  const generateText =
    vi.fn<(options: GenerateTextArgs) => Promise<GenerateTextResult>>();
  const worker = createLearningWorker({
    episodes,
    store,
    state,
    generateText,
    getModels: () => [{ providerId: 'test', modelId: 'model' }],
    logger,
    now: () => Date.parse('2026-10-02T00:00:00.000Z'),
  });
  return { root, episodes, store, state, generateText, worker };
}

describe('learning fixtures', () => {
  it('are valid episodes the feed reads completely', async () => {
    const { episodes } = await harness();
    const refs = await episodes.listLatestCompleted(10);
    expect(refs.map((ref) => ref.id)).toEqual(EPISODES.map(([, id]) => id));
    for (const [file, id] of EPISODES) {
      const episode = await episodes.read(id);
      // Every line parsed: guards the fixtures against format drift.
      expect(episode?.recordCount).toBe(await recordLines(file));
    }
  });

  it('runs extraction end to end and records provenance', async () => {
    const { store, state, generateText, worker } = await harness();
    const [feedbackId, fixId, noLessonId] = EPISODES.map(([, id]) => id);

    generateText
      .mockImplementationOnce(async ({ system, prompt }) => {
        expect(system).toContain('## What counts as a lesson');
        expect(system).toContain('## What is not a lesson');
        expect(system).toContain('## Output format');
        expect(system).not.toMatch(/\{\{[A-Z_]+\}\}/);
        expect(prompt).toContain('<skills>\n(none)\n</skills>');
        expect(prompt).toContain(`<episode id="${feedbackId}"`);
        expect(prompt).toContain('always ask before changing a core contract');
        return reply({
          op: 'create',
          name: 'ask-before-core-contract-changes',
          description:
            'Use before changing a published protocol, payload, or other core contract.',
          body: '1. Propose the change and its impact.\n2. Wait for approval before editing.',
          reason: 'Teammate asked to be consulted first.',
        });
      })
      .mockImplementationOnce(async ({ prompt }) => {
        expect(prompt).toContain(
          '<skill name="ask-before-core-contract-changes">',
        );
        expect(prompt).toContain(`<episode id="${fixId}"`);
        expect(prompt).toContain('Node.js 26 is required');
        return reply({
          op: 'create',
          name: 'use-pinned-node-version',
          description:
            'Use before running repository scripts on a machine whose default Node may be older.',
          body: 'Run `nvm use` in the repository root first; it reads `.nvmrc`.',
          reason: 'A failed run succeeded after switching Node.',
        });
      })
      .mockImplementationOnce(async ({ prompt }) => {
        expect(prompt).toContain('<skill name="use-pinned-node-version">');
        expect(prompt).toContain(`<episode id="${noLessonId}"`);
        expect(prompt).toContain('team lunch');
        return reply();
      });

    expect(await worker.runOnce()).toBe('processed');
    expect(generateText).toHaveBeenCalledTimes(3);

    expect(
      store
        .list()
        .map((skill) => skill.name)
        .sort(),
    ).toEqual(['ask-before-core-contract-changes', 'use-pinned-node-version']);
    const current = state.get();
    expect(current.cursor).toBe(noLessonId);
    expect(
      current.skills['ask-before-core-contract-changes']?.sourceEpisodes,
    ).toEqual([feedbackId]);
    expect(current.skills['use-pinned-node-version']?.sourceEpisodes).toEqual([
      fixId,
    ]);
    expect(current.changedRunsSinceConsolidation).toBe(0);
    expect(current.lastConsolidationAt).toBeNull();
    expect(current.pendingChangeWeight).toBe(4);
    expect(current.processedEpisodeCount).toBe(3);
  });

  it('writes learned skills as Agent Skills files', async () => {
    const { root, generateText, worker } = await harness();
    generateText
      .mockResolvedValueOnce(
        reply({
          op: 'create',
          name: 'ask-before-core-contract-changes',
          description: 'Use before changing a core contract.',
          body: 'Ask first.',
          reason: 'feedback',
        }),
      )
      .mockResolvedValue(reply());

    await worker.runOnce();

    const content = await readFile(
      join(
        root,
        'learning',
        'skills',
        'ask-before-core-contract-changes',
        'SKILL.md',
      ),
      'utf8',
    );
    expect(content).toBe(
      '---\nname: "ask-before-core-contract-changes"\n' +
        'description: "Use before changing a core contract."\n---\n\nAsk first.\n',
    );
  });
});
