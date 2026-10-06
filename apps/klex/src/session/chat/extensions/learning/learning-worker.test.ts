import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ModuleLogger } from '@stagewise/logger';

import type {
  CompletedEpisode,
  EpisodeFeed,
} from '@/session/chat/extensions/memory';

import type { GenerateTextArgs, GenerateTextResult } from '../extension-api';
import {
  CONSOLIDATE_CHANGE_WEIGHT,
  INITIAL_BACKFILL_EPISODES,
  MAX_FAILURES_PER_EPISODE,
  MAX_SKILLS,
  MIN_EPISODE_CHARACTERS,
} from './learning-config';
import { createLearningState } from './learning-state';
import { createLearningWorker } from './learning-worker';
import { createSkillStore } from './skill-store';

vi.mock('./extraction-prompt.md', () => ({ default: 'Extract.' }));
vi.mock('./consolidation-prompt.md', () => ({ default: 'Consolidate.' }));
vi.mock('./system-prompt-part.md', () => ({ default: '## Learned skills\n' }));

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const LONG_TEXT = 'x'.repeat(MIN_EPISODE_CHARACTERS);

function episodeId(index: number): string {
  return `2026-10-01/${String(index).padStart(3, '0')}-10-00.jsonl`;
}

function fakeFeed(
  count: number,
  textOf: (index: number) => string = () => LONG_TEXT,
  available = true,
): EpisodeFeed & { reads: string[] } {
  const ids = Array.from({ length: count }, (_, index) => episodeId(index));
  const ref = (id: string) => ({
    id,
    date: '2026-10-01',
    index: ids.indexOf(id),
  });
  const reads: string[] = [];
  return {
    reads,
    subscribe: () => () => undefined,
    listNeighbors: async () => [],
    readPage: async (id, options) => {
      const index = ids.indexOf(id);
      if (index < 0) return null;
      reads.push(id);
      const text = textOf(index);
      return {
        id,
        text: options.tail
          ? text.slice(-options.limit)
          : text.slice(options.offset, options.offset + options.limit),
        startedAt: '2026-10-01T10:00:00.000Z',
        endedAt: '2026-10-01T10:30:00.000Z',
        offset: options.offset,
        nextOffset: null,
        scannedBytes: text.length,
        truncated: false,
      };
    },
    search: async () => ({
      matches: [],
      nextOffset: null,
      scannedBytes: 0,
      truncated: false,
    }),
    isAvailable: () => available,
    listCompleted: async (after, limit) =>
      ids
        .filter((id) => after === null || id > after)
        .slice(0, limit)
        .map(ref),
    listLatestCompleted: async (latest) => ids.slice(-latest).map(ref),
    // Ids are zero-padded here, so string order is episode order.
    compareIds: (left, right) => (left < right ? -1 : left > right ? 1 : 0),
    read: async (id): Promise<CompletedEpisode | null> => {
      reads.push(id);
      const index = ids.indexOf(id);
      if (index < 0) return null;
      return {
        ...ref(id),
        startedAt: '2026-10-01T10:00:00.000Z',
        endedAt: '2026-10-01T10:30:00.000Z',
        recordCount: 1,
        text: textOf(index),
      };
    },
  };
}

function ok(text: string): GenerateTextResult {
  return { success: true, text } as GenerateTextResult;
}

function failed(failureReason: string): GenerateTextResult {
  return { success: false, failureReason } as GenerateTextResult;
}

function createReply(name: string): string {
  return JSON.stringify({
    operations: [
      {
        op: 'create',
        name,
        description: `Use when ${name} applies.`,
        body: `Do ${name}.`,
        reason: 'lesson',
      },
    ],
  });
}

async function harness(feed: EpisodeFeed) {
  const dataDir = await mkdtemp(join(tmpdir(), 'klex-learning-worker-'));
  directories.push(dataDir);
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as ModuleLogger;
  const store = createSkillStore(join(dataDir, 'skills'), logger);
  const state = createLearningState(dataDir);
  await Promise.all([store.start(), state.start()]);
  const generateText = vi.fn(async (_args: GenerateTextArgs) =>
    ok('{"operations": []}'),
  );
  const worker = createLearningWorker({
    episodes: feed,
    store,
    state,
    generateText,
    getModels: () => [{ providerId: 'test', modelId: 'model' }],
    logger,
    now: () => Date.parse('2026-10-02T00:00:00.000Z'),
  });
  return { worker, store, state, generateText, dataDir };
}

describe('learning worker', () => {
  it('consolidates at weight twenty during a burst and never by elapsed time', async () => {
    const { worker, state, generateText } = await harness(fakeFeed(11));
    let extraction = 0;
    generateText.mockImplementation(async ({ system }) =>
      ok(
        system?.startsWith('Extract.')
          ? createReply(`lesson-${extraction++}`)
          : '{"operations": []}',
      ),
    );
    await worker.runOnce();
    expect(generateText).toHaveBeenCalledTimes(12);
    expect(state.get()).toMatchObject({
      processedEpisodeCount: 11,
      pendingChangeWeight: 2,
      lastConsolidationEpisode: 10,
    });
    expect(await worker.runOnce()).toBe('idle');
    expect(generateText).toHaveBeenCalledTimes(12);
    await worker.close();
  });

  it('does not count unchanged rewrites or refresh their activity age', async () => {
    const { worker, state, generateText } = await harness(fakeFeed(2));
    const initial = JSON.parse(createReply('lesson')) as {
      operations: object[];
    };
    generateText
      .mockResolvedValueOnce(ok(JSON.stringify(initial)))
      .mockResolvedValueOnce(
        ok(
          JSON.stringify({
            operations: initial.operations.map((operation) => ({
              ...operation,
              op: 'update',
            })),
          }),
        ),
      );
    await worker.runOnce();
    expect(state.get().pendingChangeWeight).toBe(2);
    expect(state.get().processedEpisodeCount).toBe(2);
    expect(state.get().skills.lesson?.updatedEpisode).toBe(0);
  });

  it('retains weight from earlier persisted operations when a later write fails', async () => {
    const { worker, store, state, generateText } = await harness(fakeFeed(1));
    const first = JSON.parse(createReply('first')) as { operations: object[] };
    const second = JSON.parse(createReply('second')) as {
      operations: object[];
    };
    generateText.mockResolvedValue(
      ok(
        JSON.stringify({
          operations: [...first.operations, ...second.operations],
        }),
      ),
    );
    const original = store.write.bind(store);
    vi.spyOn(store, 'write').mockImplementation(async (skill) => {
      if (skill.name === 'second') throw new Error('write failed');
      await original(skill);
    });
    expect(await worker.runOnce()).toBe('retry-later');
    expect(store.list().map((skill) => skill.name)).toEqual(['first']);
    expect(state.get()).toMatchObject({
      pendingChangeWeight: 2,
      processedEpisodeCount: 0,
    });
  });

  it('persists deferred references and revisits only after newer progress without recounting', async () => {
    const { worker, state, generateText, dataDir } = await harness(fakeFeed(2));
    generateText
      .mockResolvedValueOnce(ok('{"operations": [], "deferred": true}'))
      .mockResolvedValueOnce(ok('{"operations": []}'))
      .mockResolvedValueOnce(ok(createReply('verified-fix')));
    await worker.runOnce();
    expect(generateText).toHaveBeenCalledTimes(3);
    expect(state.get()).toMatchObject({
      processedEpisodeCount: 2,
      cursor: episodeId(1),
      deferred: [],
      pendingChangeWeight: 2,
    });
    expect(state.get().skills['verified-fix']?.sourceEpisodes).toEqual([
      episodeId(0),
    ]);
    const reloaded = createLearningState(dataDir);
    await reloaded.start();
    expect(reloaded.get().processedEpisodeCount).toBe(2);
    await worker.runOnce();
    expect(generateText).toHaveBeenCalledTimes(3);
  });

  it('spaces consolidation failures by episode activity, not drain passes', async () => {
    const { worker, store, state, generateText } = await harness(fakeFeed(0));
    for (const name of ['one', 'two'])
      await store.write({ name, description: `Use when ${name}.`, body: name });
    await state.update((draft) => {
      draft.pendingChangeWeight = 20;
    });
    generateText.mockResolvedValue(failed('provider unavailable'));
    await worker.runOnce();
    expect(state.get()).toMatchObject({
      pendingChangeWeight: 20,
      consolidationFailures: 1,
      nextConsolidationEpisode: 1,
    });
    await worker.runOnce();
    expect(generateText).toHaveBeenCalledTimes(1);
    await state.update((draft) => {
      draft.processedEpisodeCount = 1;
    });
    await worker.runOnce();
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(state.get().nextConsolidationEpisode).toBe(3);
  });

  it('cancels in-flight investigation without committing or recording failures', async () => {
    const { worker, state, store, generateText } = await harness(fakeFeed(2));
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    generateText.mockImplementation(async ({ abortSignal }) => {
      started();
      await new Promise<void>((resolve) =>
        abortSignal?.addEventListener('abort', () => resolve(), { once: true }),
      );
      return ok(createReply('late-proposal'));
    });
    const run = worker.runOnce();
    await ready;
    await worker.close();
    await run;
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(store.list()).toEqual([]);
    expect(state.get()).toMatchObject({
      processedEpisodeCount: 0,
      episodeFailures: {},
      cursor: null,
    });
  });
  it('does nothing while memory is unavailable', async () => {
    const { worker, generateText } = await harness(
      fakeFeed(3, undefined, false),
    );
    expect(await worker.runOnce()).toBe('unavailable');
    expect(generateText).not.toHaveBeenCalled();
  });

  it('backfills only the newest episodes and records provenance', async () => {
    const total = INITIAL_BACKFILL_EPISODES + 5;
    const feed = fakeFeed(total);
    const { worker, store, state, generateText } = await harness(feed);
    generateText.mockResolvedValueOnce(ok(createReply('ask-first')));

    expect(await worker.runOnce()).toBe('processed');

    const firstBackfilled = total - INITIAL_BACKFILL_EPISODES;
    expect(feed.reads).toEqual(
      Array.from({ length: INITIAL_BACKFILL_EPISODES }, (_, offset) =>
        episodeId(firstBackfilled + offset),
      ),
    );
    expect(store.list().map((skill) => skill.name)).toEqual(['ask-first']);
    const current = state.get();
    expect(current.skills['ask-first']?.sourceEpisodes).toEqual([
      episodeId(firstBackfilled),
    ]);
    expect(current.cursor).toBe(
      episodeId(firstBackfilled + INITIAL_BACKFILL_EPISODES - 1),
    );
    expect(current.pendingChangeWeight).toBe(2);
    expect(current.processedEpisodeCount).toBe(INITIAL_BACKFILL_EPISODES);
  });

  it('pins the backfill window when the first episode fails', async () => {
    const total = INITIAL_BACKFILL_EPISODES + 5;
    const { worker, state, generateText } = await harness(fakeFeed(total));
    generateText.mockResolvedValueOnce(failed('provider down'));

    expect(await worker.runOnce()).toBe('retry-later');
    expect(state.get().cursor).toBe(
      episodeId(total - INITIAL_BACKFILL_EPISODES - 1),
    );
  });

  it('carries provenance of merged skills over to the survivor', async () => {
    const { worker, store, state, generateText } = await harness(fakeFeed(0));
    for (const name of ['keep-me', 'drop-me']) {
      await store.write({
        name,
        description: `Use when ${name}.`,
        body: 'Body.',
      });
    }
    const usage = (sourceEpisodes: string[]) => ({
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      lastReadAt: null,
      readCount: 0,
      sourceEpisodes,
    });
    await state.update((draft) => {
      draft.cursor = episodeId(0);
      draft.pendingChangeWeight = CONSOLIDATE_CHANGE_WEIGHT;
      // The survivor's source is newer, so plain concatenation is out of order.
      draft.skills['keep-me'] = usage([episodeId(2)]);
      draft.skills['drop-me'] = usage([episodeId(1)]);
    });
    generateText.mockResolvedValueOnce(
      ok(
        JSON.stringify({
          operations: [
            { op: 'delete', name: 'drop-me', reason: 'merged' },
            {
              op: 'update',
              name: 'keep-me',
              description: 'Use when keep-me.',
              body: 'Merged.',
              mergedFrom: ['drop-me'],
            },
          ],
        }),
      ),
    );

    await worker.runOnce();
    expect(state.get().skills['keep-me']?.sourceEpisodes).toEqual([
      episodeId(1),
      episodeId(2),
    ]);
  });

  it('retries a failed first episode after the backfill window grows', async () => {
    const full = fakeFeed(INITIAL_BACKFILL_EPISODES + 5);
    let visible = INITIAL_BACKFILL_EPISODES;
    const shown = async (after: string | null) =>
      (await full.listCompleted(after, Number.POSITIVE_INFINITY)).filter(
        (ref) => ref.index < visible,
      );
    const feed: EpisodeFeed = {
      ...full,
      listCompleted: async (after, limit) =>
        (await shown(after)).slice(0, limit),
      listLatestCompleted: async (count) => (await shown(null)).slice(-count),
    };
    const { worker, state, generateText } = await harness(feed);
    generateText.mockResolvedValueOnce(failed('provider down'));

    expect(await worker.runOnce()).toBe('retry-later');
    expect(state.get().cursor).toBeNull();

    visible = INITIAL_BACKFILL_EPISODES + 5;
    expect(await worker.runOnce()).toBe('processed');
    expect(full.reads.slice(0, 2)).toEqual([episodeId(0), episodeId(0)]);
  });

  it('restores skill state when the skill file write fails', async () => {
    const { worker, store, state, generateText, dataDir } = await harness(
      fakeFeed(1),
    );
    await store.write({
      name: 'ask-first',
      description: 'Use when ask-first.',
      body: 'Old.',
    });
    const before = {
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      lastReadAt: null,
      readCount: 0,
      sourceEpisodes: [],
    };
    await state.update((draft) => {
      draft.skills['ask-first'] = before;
    });
    // A symlinked folder makes the store reject the write.
    const folder = join(dataDir, 'skills', 'ask-first');
    await rm(folder, { recursive: true });
    await symlink(dataDir, folder);
    generateText.mockResolvedValueOnce(
      ok(
        JSON.stringify({
          operations: [
            {
              op: 'update',
              name: 'ask-first',
              description: 'Use when ask-first.',
              body: 'New.',
              reason: 'lesson',
            },
          ],
        }),
      ),
    );

    expect(await worker.runOnce()).toBe('retry-later');
    expect(state.get().skills['ask-first']).toEqual(before);
    expect(state.get().episodeFailures[episodeId(0)]).toBe(1);
  });

  it('keeps reads recorded while a failed skill write was in flight', async () => {
    const { worker, store, state, generateText, dataDir } = await harness(
      fakeFeed(1),
    );
    await store.write({
      name: 'ask-first',
      description: 'Use when ask-first.',
      body: 'Old.',
    });
    const before = {
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      lastReadAt: null,
      readCount: 0,
      sourceEpisodes: [],
    };
    await state.update((draft) => {
      draft.skills['ask-first'] = before;
    });
    const folder = join(dataDir, 'skills', 'ask-first');
    await rm(folder, { recursive: true });
    await symlink(dataDir, folder);
    const readAt = '2026-10-01T12:00:00.000Z';
    const write = store.write.bind(store);
    vi.spyOn(store, 'write').mockImplementation(async (skill) => {
      // A concurrent readSkill lands between the state update and the write.
      await state.update((draft) => {
        const entry = draft.skills['ask-first'];
        if (entry) {
          entry.readCount += 1;
          entry.lastReadAt = readAt;
        }
      });
      return write(skill);
    });
    generateText.mockResolvedValueOnce(
      ok(
        JSON.stringify({
          operations: [
            {
              op: 'update',
              name: 'ask-first',
              description: 'Use when ask-first.',
              body: 'New.',
              reason: 'lesson',
            },
          ],
        }),
      ),
    );

    expect(await worker.runOnce()).toBe('retry-later');
    expect(state.get().skills['ask-first']).toEqual({
      ...before,
      lastReadAt: readAt,
      readCount: 1,
    });
  });

  it('skips short episodes without a model call', async () => {
    const { worker, state, generateText } = await harness(
      fakeFeed(2, () => 'short'),
    );
    expect(await worker.runOnce()).toBe('processed');
    expect(generateText).not.toHaveBeenCalled();
    expect(state.get().cursor).toBe(episodeId(1));
  });

  it('retries a failing episode, then skips it', async () => {
    const { worker, state, generateText } = await harness(fakeFeed(1));
    generateText.mockResolvedValue(failed('provider down'));

    for (let attempt = 1; attempt < MAX_FAILURES_PER_EPISODE; attempt += 1) {
      expect(await worker.runOnce()).toBe('retry-later');
      expect(state.get().cursor).toBeNull();
      expect(state.get().episodeFailures[episodeId(0)]).toBe(attempt);
    }

    expect(await worker.runOnce()).toBe('processed');
    expect(state.get().cursor).toBe(episodeId(0));
    expect(state.get().episodeFailures).toEqual({});
  });

  it('treats an unparseable reply as a failure', async () => {
    const { worker, state, generateText } = await harness(fakeFeed(1));
    generateText.mockResolvedValueOnce(ok('not json'));
    expect(await worker.runOnce()).toBe('retry-later');
    expect(state.get().cursor).toBeNull();
  });

  it('consolidates after enough weighted changes', async () => {
    const { worker, store, state, generateText } = await harness(fakeFeed(0));
    for (const name of ['keep-me', 'drop-me']) {
      await store.write({
        name,
        description: `Use when ${name}.`,
        body: 'Body.',
      });
    }
    await state.update((draft) => {
      draft.cursor = episodeId(0);
      draft.pendingChangeWeight = CONSOLIDATE_CHANGE_WEIGHT;
      draft.skills['drop-me'] = {
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
        lastReadAt: null,
        readCount: 0,
        sourceEpisodes: [episodeId(0)],
      };
    });
    generateText.mockResolvedValueOnce(
      ok(
        JSON.stringify({
          operations: [{ op: 'delete', name: 'drop-me', reason: 'duplicate' }],
        }),
      ),
    );

    expect(await worker.runOnce()).toBe('idle');
    expect(store.list().map((skill) => skill.name)).toEqual(['keep-me']);
    expect(state.get().skills['drop-me']).toBeUndefined();
    expect(state.get().pendingChangeWeight).toBe(0);
    expect(state.get().lastConsolidationAt).toBe('2026-10-02T00:00:00.000Z');
  });

  it('evicts least-recently-used skills above the cap', async () => {
    const { worker, store, state, generateText } = await harness(fakeFeed(0));
    generateText.mockResolvedValue(failed('provider down'));
    const names = Array.from(
      { length: MAX_SKILLS + 1 },
      (_, index) => `skill-${index}`,
    );
    for (const name of names) {
      await store.write({ name, description: 'Use when x.', body: 'Body.' });
    }
    await state.update((draft) => {
      draft.cursor = episodeId(0);
      for (const name of names.slice(1)) {
        draft.skills[name] = {
          createdAt: '2026-10-01T00:00:00.000Z',
          updatedAt: '2026-10-01T00:00:00.000Z',
          lastReadAt: null,
          readCount: 0,
          sourceEpisodes: [],
        };
      }
    });

    expect(await worker.runOnce()).toBe('idle');
    expect(store.list()).toHaveLength(MAX_SKILLS);
    expect(store.get('skill-0')).toBeNull();
  });

  it('does not overlap runs', async () => {
    const { worker, generateText } = await harness(fakeFeed(1));
    let release: (value: GenerateTextResult) => void = () => {};
    generateText.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const first = worker.runOnce();
    const second = worker.runOnce();
    expect(second).toBe(first);
    await vi.waitFor(() => expect(generateText).toHaveBeenCalledTimes(1));
    release(ok('{"operations": []}'));
    expect(await first).toBe('processed');
  });

  it('close waits for the in-flight run', async () => {
    const { worker, state, generateText } = await harness(fakeFeed(1));
    let release: (value: GenerateTextResult) => void = () => {};
    generateText.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    void worker.runOnce();
    await vi.waitFor(() => expect(generateText).toHaveBeenCalledTimes(1));
    let closed = false;
    const closing = worker.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release(ok('{"operations": []}'));
    await closing;
    expect(state.get().cursor).toBeNull();
    expect(state.get().episodeFailures).toEqual({});
    expect(generateText.mock.calls[0]?.[0].abortSignal?.aborted).toBe(true);
  });

  it('starts catch-up immediately without a learning timer', async () => {
    const { worker, generateText } = await harness(fakeFeed(1));
    worker.start();
    await vi.waitFor(() => expect(generateText).toHaveBeenCalledTimes(1));
    await worker.close();
  });
});
