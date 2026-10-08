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
import { executeFixtureSubmission } from './test-generation';

vi.mock('@/session/chat/extensions/time/system-prompt.md', () => ({
  default: '',
}));

vi.mock('./extraction-prompt.md', () => ({
  default: 'Extract. {{NAME}}\n<soul>{{SOUL}}</soul>',
}));
vi.mock('./consolidation-prompt.md', () => ({
  default: 'Consolidate. {{NAME}}\n<soul>{{SOUL}}</soul>',
}));
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

function ok(text: string): Extract<GenerateTextResult, { success: true }> {
  return {
    success: true,
    text,
    modelId: 'model',
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      inputTokenDetails: {
        noCacheTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      outputTokenDetails: { textTokens: 1, reasoningTokens: 0 },
    },
  };
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
  const generateText = vi.fn<
    (args: GenerateTextArgs) => Promise<GenerateTextResult>
  >(async () => ok('{"operations": []}'));
  const getAgent = vi.fn(() => ({ name: 'Atlas', soul: 'Initial soul' }));
  let now = Date.parse('2026-10-02T00:00:00.000Z');
  const worker = createLearningWorker({
    episodes: feed,
    store,
    state,
    generateText: async (args) =>
      executeFixtureSubmission(args, await generateText(args)),
    getModels: () => [{ providerId: 'test', modelId: 'model' }],
    getAgent,
    logger,
    now: () => now,
  });
  return {
    worker,
    store,
    state,
    generateText,
    getAgent,
    dataDir,
    logger,
    advanceClock: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

describe('learning worker', () => {
  it('commits a tool submission regardless of response text', async () => {
    const { worker, store, generateText } = await harness(fakeFeed(1));
    generateText.mockImplementationOnce(async (args) => {
      expect(args.completionTool?.name).toBe('submitLearnings');
      const result = await executeFixtureSubmission(
        args,
        ok(createReply('lesson')),
      );
      if (!result.success) throw new Error('Expected fixture success');
      return { ...result, text: 'This is prose, not JSON.' };
    });
    expect(await worker.runOnce()).toBe('processed');
    expect(store.get('lesson')).not.toBeNull();
  });

  it('never treats JSON response text as a submission', async () => {
    const { worker, state, store, generateText } = await harness(fakeFeed(1));
    generateText.mockResolvedValueOnce({
      ...ok(createReply('lesson')),
      toolResults: [],
    });
    expect(await worker.runOnce()).toBe('retry-later');
    expect(state.get().cursor).toBeNull();
    expect(store.list()).toEqual([]);
  });

  it('does not commit a staged submission when generation subsequently fails', async () => {
    const { worker, state, store, generateText } = await harness(fakeFeed(1));
    generateText.mockImplementationOnce(async (args) => {
      const submitted = await executeFixtureSubmission(
        args,
        ok(createReply('lesson')),
      );
      expect(
        submitted.success && submitted.toolResults?.[0]?.output,
      ).toMatchObject({ status: 'accepted' });
      expect(store.list()).toEqual([]);
      expect(state.get().skills).toEqual({});
      return failed('all-models-failed');
    });
    expect(await worker.runOnce()).toBe('retry-later');
    expect(store.list()).toEqual([]);
    expect(state.get().cursor).toBeNull();
  });

  it('allows correction of a rejected batch before committing a valid submission', async () => {
    const { worker, store, generateText } = await harness(fakeFeed(1));
    generateText.mockImplementationOnce(async (args) => {
      const rejected = await executeFixtureSubmission(
        args,
        ok(
          JSON.stringify({
            operations: [{ op: 'delete', name: 'missing', reason: 'obsolete' }],
          }),
        ),
      );
      const accepted = await executeFixtureSubmission(
        args,
        ok(createReply('lesson')),
      );
      if (!rejected.success || !accepted.success)
        throw new Error('Expected fixture success');
      expect(rejected.toolResults?.[0]?.output).toMatchObject({
        status: 'rejected',
      });
      return {
        ...accepted,
        toolResults: [
          ...(rejected.toolResults ?? []),
          ...(accepted.toolResults ?? []),
        ],
      };
    });
    expect(await worker.runOnce()).toBe('processed');
    expect(store.list().map((skill) => skill.name)).toEqual(['lesson']);
  });

  it('reads current name and soul for each extraction rather than caching identity', async () => {
    const { worker, generateText, getAgent } = await harness(fakeFeed(2));
    generateText.mockImplementationOnce(async ({ system }) => {
      expect(system).toContain('Extract. Atlas');
      expect(system).toContain('<soul>Initial soul</soul>');
      getAgent.mockReturnValue({ name: 'Kristine', soul: 'Updated soul' });
      return ok('{"operations": []}');
    });
    generateText.mockImplementationOnce(async ({ system }) => {
      expect(system).toContain('Extract. Kristine');
      expect(system).toContain('<soul>Updated soul</soul>');
      return ok('{"operations": []}');
    });
    expect(await worker.runOnce()).toBe('processed');
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(getAgent).toHaveBeenCalledTimes(2);
    await worker.close();
  });

  it('reads current name and soul when consolidating after extraction', async () => {
    const { worker, generateText, getAgent } = await harness(fakeFeed(10));
    let extraction = 0;
    generateText.mockImplementation(async ({ system }) => {
      if (system?.startsWith('Extract.')) {
        getAgent.mockReturnValue({ name: 'Kristine', soul: 'Updated soul' });
        return ok(createReply(`lesson-${extraction++}`));
      }
      expect(system).toContain('Consolidate. Kristine');
      expect(system).toContain('<soul>Updated soul</soul>');
      expect(system).not.toMatch(/\{\{(?:NAME|SOUL)\}\}/);
      return ok('{"operations": []}');
    });
    expect(await worker.runOnce()).toBe('processed');
    expect(generateText).toHaveBeenCalledTimes(11);
    expect(getAgent).toHaveBeenCalledTimes(11);
    await worker.close();
  });

  it('consolidates at weight twenty during a burst and never by elapsed time', async () => {
    const { worker, state, generateText, advanceClock } = await harness(
      fakeFeed(11),
    );
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
    advanceClock(365 * 24 * 60 * 60_000);
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

  it('preserves new evidence on unchanged skills without refreshing their age or weight', async () => {
    const { worker, state, store, generateText } = await harness(fakeFeed(2));
    const skill = {
      name: 'lesson',
      description: 'Use when lesson applies.',
      body: 'Do lesson.',
    };
    await store.write(skill);
    await state.update((draft) => {
      draft.processedEpisodeCount = 10;
      draft.skills.lesson = {
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
        lastReadAt: null,
        readCount: 0,
        sourceEpisodes: [],
        createdEpisode: 0,
        updatedEpisode: 3,
        lastReadEpisode: null,
      };
    });
    const write = vi.spyOn(store, 'write');
    generateText.mockImplementationOnce(async ({ tools, abortSignal }) => {
      await tools?.readEpisode?.execute?.(
        { id: episodeId(1), offset: 0, limit: 100 },
        {
          toolCallId: 'evidence',
          messages: [],
          context: undefined,
          abortSignal,
        },
      );
      return ok(
        JSON.stringify({
          operations: [
            { op: 'update', ...skill, evidenceEpisodes: [episodeId(1)] },
          ],
        }),
      );
    });
    await worker.runOnce();
    expect(state.get().skills.lesson).toMatchObject({
      sourceEpisodes: [episodeId(0), episodeId(1)],
      updatedEpisode: 3,
      updatedAt: '2026-10-01T00:00:00.000Z',
    });
    expect(state.get().pendingChangeWeight).toBe(0);
    expect(write).not.toHaveBeenCalled();
  });

  it('retries failed deferred investigation without consuming a revisit or requiring new progress', async () => {
    const { worker, state, generateText } = await harness(fakeFeed(2));
    generateText
      .mockResolvedValueOnce(ok('{"operations": [], "deferred": true}'))
      .mockResolvedValueOnce(ok('{"operations": []}'))
      .mockResolvedValueOnce(failed('provider unavailable'))
      .mockRejectedValueOnce(new Error('provider exception'))
      .mockResolvedValueOnce(ok(createReply('recovered')));
    expect(await worker.runOnce()).toBe('retry-later');
    expect(state.get()).toMatchObject({
      processedEpisodeCount: 2,
      deferred: [{ id: episodeId(0), attempts: 0, after: episodeId(0) }],
      episodeFailures: { [episodeId(0)]: 1 },
    });
    expect(await worker.runOnce()).toBe('retry-later');
    expect(state.get().deferred[0]?.attempts).toBe(0);
    expect(await worker.runOnce()).toBe('idle');
    expect(state.get()).toMatchObject({
      processedEpisodeCount: 2,
      deferred: [],
      episodeFailures: {},
    });
    expect(state.get().skills.recovered).toBeDefined();
  });

  it('retains the partial marker when the primary page fills the character budget', async () => {
    const feed = fakeFeed(1, () => 'x'.repeat(60_000));
    const read = feed.readPage.bind(feed);
    feed.readPage = async (id, options) => {
      const page = await read(id, options);
      return page ? { ...page, truncated: true } : null;
    };
    const { worker, generateText } = await harness(feed);
    await worker.runOnce();
    expect(generateText.mock.calls[0]?.[0].prompt).toContain(
      '[Partial episode: scan budget exhausted; uninspected content is not evidence.]',
    );
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
    generateText.mockImplementation(async (args) => {
      const staged = await executeFixtureSubmission(
        args,
        ok(createReply('late-proposal')),
      );
      started();
      await new Promise<void>((resolve) =>
        args.abortSignal?.addEventListener('abort', () => resolve(), {
          once: true,
        }),
      );
      return staged;
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
  it('does not start generation after shutdown during an episode read', async () => {
    const feed = fakeFeed(1);
    const readPage = feed.readPage;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reading = false;
    feed.readPage = async (...args) => {
      reading = true;
      await blocked;
      return readPage(...args);
    };
    const { worker, state, store, generateText } = await harness(feed);
    const run = worker.runOnce();
    await vi.waitFor(() => expect(reading).toBe(true));
    const closing = worker.close();
    release();
    await Promise.all([run, closing]);
    expect(generateText).not.toHaveBeenCalled();
    expect(store.list()).toEqual([]);
    expect(state.get()).toMatchObject({
      cursor: null,
      processedEpisodeCount: 0,
      episodeFailures: {},
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

  it('counts read exceptions per episode and reaches later episodes after the retry ceiling', async () => {
    const feed = fakeFeed(2);
    const read = feed.readPage.bind(feed);
    feed.readPage = async (id, options) => {
      if (id === episodeId(0)) throw new Error('unreadable episode');
      return read(id, options);
    };
    const { worker, state, generateText, logger } = await harness(feed);
    for (let attempt = 1; attempt < MAX_FAILURES_PER_EPISODE; attempt++) {
      expect(await worker.runOnce()).toBe('retry-later');
      expect(state.get().episodeFailures[episodeId(0)]).toBe(attempt);
      expect(state.get().cursor).toBeNull();
    }
    expect(await worker.runOnce()).toBe('processed');
    expect(state.get()).toMatchObject({
      cursor: episodeId(1),
      processedEpisodeCount: 2,
      episodeFailures: {},
    });
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        episode: episodeId(0),
        failures: MAX_FAILURES_PER_EPISODE,
      }),
      'Skipping episode after repeated learning failures',
    );
  });

  it('records a truncated empty scan as a failure rather than silently skipping it', async () => {
    const feed = fakeFeed(1, () => '');
    const read = feed.readPage.bind(feed);
    feed.readPage = async (id, options) => {
      const page = await read(id, options);
      return page
        ? { ...page, startedAt: null, endedAt: null, truncated: true }
        : null;
    };
    const { worker, state, generateText } = await harness(feed);
    expect(await worker.runOnce()).toBe('retry-later');
    expect(state.get()).toMatchObject({
      cursor: null,
      processedEpisodeCount: 0,
      episodeFailures: { [episodeId(0)]: 1 },
    });
    expect(generateText).not.toHaveBeenCalled();
  });

  it('treats a missing submission as a failure', async () => {
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

  it('preserves historical recency of migrated skills when enforcing the cap', async () => {
    const { worker, store, state, generateText } = await harness(fakeFeed(0));
    generateText.mockResolvedValue(failed('provider down'));
    for (let index = 0; index <= MAX_SKILLS; index++) {
      const name = `skill-${index}`;
      await store.write({ name, description: 'Use when x.', body: 'Body.' });
      await state.update((draft) => {
        draft.skills[name] = {
          createdAt: '2026-10-01T00:00:00.000Z',
          updatedAt: '2026-10-01T00:00:00.000Z',
          lastReadAt: index === 0 ? '2026-10-02T00:00:00.000Z' : null,
          readCount: index === 0 ? 1 : 100,
          createdEpisode: 0,
          updatedEpisode: 0,
          lastReadEpisode: null,
          sourceEpisodes: [],
        };
      });
    }
    await worker.runOnce();
    expect(store.list()).toHaveLength(MAX_SKILLS);
    expect(store.get('skill-0')).not.toBeNull();
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

  it('automatically drains successive unreadable episodes with a fresh retry budget after progress', async () => {
    const feed = fakeFeed(2);
    feed.readPage = async () => {
      throw new Error('unreadable');
    };
    const { worker, state } = await harness(feed);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      worker.start();
      await vi.waitFor(() =>
        expect(state.get().episodeFailures[episodeId(0)]).toBe(1),
      );
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(() =>
        expect(state.get().episodeFailures[episodeId(0)]).toBe(2),
      );
      await vi.advanceTimersByTimeAsync(120_000);
      await vi.waitFor(() =>
        expect(state.get().episodeFailures[episodeId(1)]).toBe(1),
      );
      expect(state.get().cursor).toBe(episodeId(0));
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(() =>
        expect(state.get().episodeFailures[episodeId(1)]).toBe(2),
      );
      await vi.advanceTimersByTimeAsync(120_000);
      await vi.waitFor(() => expect(state.get().cursor).toBe(episodeId(1)));
      expect(state.get().processedEpisodeCount).toBe(2);
    } finally {
      await worker.close();
      vi.useRealTimers();
    }
  });

  it('starts catch-up immediately without a learning timer', async () => {
    const { worker, generateText } = await harness(fakeFeed(1));
    worker.start();
    await vi.waitFor(() => expect(generateText).toHaveBeenCalledTimes(1));
    await worker.close();
  });
});
