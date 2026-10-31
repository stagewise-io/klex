import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ModuleLogger } from '@stagewise/logger';

import type {
  CompletedEpisode,
  EpisodeFeed,
} from '@/session/chat/extensions/memory';
import {
  createSkillRegistry,
  type SkillDocument,
  type SkillPutOptions,
} from '@/skills';

import {
  CONSOLIDATE_CHANGE_WEIGHT,
  INITIAL_BACKFILL_EPISODES,
  MAX_FAILURES_PER_EPISODE,
  MAX_SKILLS,
  MIN_EPISODE_CHARACTERS,
} from './learning-config';
import { createLearningState } from './learning-state';
import { createLearningWorker } from './learning-worker';
import { sourceEpisodesOf } from './prompts';
import {
  type ChildReply,
  childHarness,
  reply as ok,
  submitFixture,
} from './test-child';

vi.mock('@/session/chat/extensions/time/system-prompt.md', () => ({
  default: '',
}));

vi.mock('./extraction-prompt.md', () => ({
  default: 'Extract. {{NAME}}\n<soul>{{SOUL}}</soul>',
}));
vi.mock('./consolidation-prompt.md', () => ({
  default: 'Consolidate. {{NAME}}\n<soul>{{SOUL}}</soul>',
}));

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

function noSubmission(text = 'No submission.'): ChildReply {
  return { text, submit: false };
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

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

async function startedRegistry(directory: string, logger: ModuleLogger) {
  const registry = createSkillRegistry({ dataDirectory: directory, logger });
  await registry.start();
  registry.claimNamespace('io.stagewise/learning', 'learning');
  return registry;
}

async function harness(feed: EpisodeFeed) {
  const dataDir = await temporaryDirectory('klex-learning-worker-');
  const registryDir = await temporaryDirectory('klex-learning-registry-');
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as ModuleLogger;
  const registry = await startedRegistry(registryDir, logger);
  const skills = registry.forNamespace('learning');
  const state = createLearningState(dataDir);
  await state.start();
  const { runChild, createChildSession, children } = childHarness();
  const getAgent = vi.fn(() => ({ name: 'Atlas', soul: 'Initial soul' }));
  let now = Date.parse('2026-10-02T00:00:00.000Z');
  const worker = createLearningWorker({
    episodes: feed,
    skills,
    state,
    createChildSession,
    getModelPurpose: () => 'memory',
    getAgent,
    logger,
    now: () => now,
  });
  return {
    worker,
    skills,
    registry,
    registryDir,
    /** Writes a skill as the learning namespace would. */
    write: (skill: SkillDocument, options?: SkillPutOptions) =>
      skills.put(
        skill.name,
        { description: skill.description, body: skill.body },
        options,
      ),
    sources: (name: string) => {
      const skill = skills.get(name);
      return skill ? sourceEpisodesOf(skill) : null;
    },
    state,
    runChild,
    createChildSession,
    children,
    getAgent,
    dataDir,
    logger,
    advanceClock: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

describe('learning worker', () => {
  it.each(['update', 'delete', 'merge'] as const)(
    'lets consolidation %s a user-edited skill',
    async (kind) => {
      const { worker, skills, registry, write, state, runChild } =
        await harness(fakeFeed(0));
      for (const name of ['edited', 'automatic'])
        await write({ name, description: 'Original.', body: 'Original.' });
      await registry.update('learning/edited', { body: 'Admin edit.' });
      expect(skills.get('edited')?.userEdited).toBe(true);
      await state.update((draft) => {
        draft.pendingChangeWeight = CONSOLIDATE_CHANGE_WEIGHT;
      });
      runChild.mockImplementation(async (task) => {
        expect(task.prompt).not.toContain('userEdited');
        const operation =
          kind === 'delete'
            ? { op: 'delete', name: 'edited', reason: 'obsolete' }
            : {
                op: 'update',
                name: kind === 'merge' ? 'automatic' : 'edited',
                description: 'Changed.',
                body: 'Changed.',
                ...(kind === 'merge' ? { mergedFrom: ['edited'] } : {}),
              };
        expect(
          await submitFixture(
            task,
            JSON.stringify({ operations: [operation] }),
          ),
        ).toMatchObject({ status: 'applied', applied: 1 });
        return noSubmission();
      });
      await worker.runOnce();
      expect(runChild).toHaveBeenCalledOnce();
      if (kind === 'delete') expect(skills.get('edited')).toBeNull();
      else if (kind === 'update')
        expect(skills.get('edited')).toMatchObject({
          body: 'Changed.',
          userEdited: false,
        });
      else expect(skills.get('automatic')?.body).toBe('Changed.');
    },
  );

  it('keeps usage and provenance but clears userEdited when extraction updates a skill', async () => {
    const { worker, skills, registry, write, sources, runChild } =
      await harness(fakeFeed(1));
    await write(
      { name: 'edited', description: 'Original.', body: 'Original.' },
      { metadata: { sourceEpisodes: ['old'] }, seed: { readCount: 3 } },
    );
    await registry.update('learning/edited', { body: 'Admin edit.' });
    runChild.mockResolvedValue(
      ok(
        JSON.stringify({
          operations: [
            {
              op: 'update',
              name: 'edited',
              description: 'Changed.',
              body: 'Changed.',
            },
          ],
        }),
      ),
    );
    await worker.runOnce();
    expect(skills.get('edited')).toMatchObject({
      body: 'Changed.',
      userEdited: false,
      readCount: 3,
    });
    expect(sources('edited')).toEqual(
      expect.arrayContaining(['old', episodeId(0)]),
    );
  });

  it('creates an evidence-cited constructor skill without treating inherited properties as usage', async () => {
    const { worker, skills, sources, runChild, registryDir, logger } =
      await harness(fakeFeed(1));
    const skill = {
      name: 'constructor',
      description: 'Use when configuring a constructor.',
      body: 'Use explicit dependencies.',
    };
    runChild.mockResolvedValueOnce(
      ok(
        JSON.stringify({
          operations: [
            { op: 'create', ...skill, evidenceEpisodes: [episodeId(0)] },
          ],
        }),
      ),
    );
    expect(await worker.runOnce()).toBe('processed');
    expect(skills.get('constructor')).toMatchObject({ ...skill, readCount: 0 });
    expect(sources('constructor')).toEqual([episodeId(0)]);
    await worker.close();
    const reloaded = await startedRegistry(registryDir, logger);
    expect(reloaded.get('learning/constructor')).toMatchObject({
      ...skill,
      metadata: { sourceEpisodes: [episodeId(0)] },
    });
  });

  it('consolidates a restored constructor skill with no bookkeeping', async () => {
    const { worker, write, state, runChild } = await harness(fakeFeed(0));
    for (const name of ['constructor', 'other'])
      await write({
        name,
        description: 'Use when appropriate.',
        body: 'Body.',
      });
    await state.update((draft) => {
      draft.pendingChangeWeight = CONSOLIDATE_CHANGE_WEIGHT;
    });
    expect(await worker.runOnce()).toBe('idle');
    expect(runChild).toHaveBeenCalledTimes(1);
    expect(runChild.mock.calls[0]?.[0].prompt).not.toContain('undefined');
  });

  it('persists through the tool and ignores response prose', async () => {
    const { worker, skills, runChild } = await harness(fakeFeed(1));
    runChild.mockImplementationOnce(async (task) => {
      expect(await submitFixture(task, createReply('lesson'))).toMatchObject({
        status: 'applied',
      });
      expect(skills.get('lesson')).not.toBeNull();
      return noSubmission('This is prose, not JSON.');
    });
    expect(await worker.runOnce()).toBe('processed');
    expect(skills.get('lesson')).not.toBeNull();
  });

  it('consumes settled episodes without treating JSON response text as a submission', async () => {
    const { worker, state, skills, runChild } = await harness(fakeFeed(1));
    runChild.mockResolvedValueOnce(noSubmission(createReply('lesson')));
    expect(await worker.runOnce()).toBe('processed');
    expect(state.get().cursor).toBe(episodeId(0));
    expect(skills.list()).toEqual([]);
    expect(await worker.runOnce()).toBe('idle');
    expect(runChild).toHaveBeenCalledOnce();
  });

  it('preserves tool writes when the child subsequently fails', async () => {
    const { worker, state, skills, runChild, children } = await harness(
      fakeFeed(1),
    );
    runChild.mockImplementationOnce(async (task) => {
      await submitFixture(task, createReply('lesson'));
      expect(skills.get('lesson')).not.toBeNull();
      throw new Error('Provider failed after persistence');
    });
    expect(await worker.runOnce()).toBe('processed');
    expect(skills.get('lesson')).not.toBeNull();
    expect(state.get().cursor).toBe(episodeId(0));
    expect(children[0]?.close).toHaveBeenCalled();
  });

  it('allows correction of a rejected batch before committing a valid submission', async () => {
    const { worker, skills, runChild } = await harness(fakeFeed(1));
    runChild.mockImplementationOnce(async (task) => {
      expect(
        await submitFixture(
          task,
          JSON.stringify({
            operations: [{ op: 'delete', name: 'missing', reason: 'obsolete' }],
          }),
        ),
      ).toMatchObject({ status: 'rejected' });
      expect(await submitFixture(task, createReply('lesson'))).toMatchObject({
        status: 'applied',
      });
      return noSubmission();
    });
    expect(await worker.runOnce()).toBe('processed');
    expect(skills.list().map((skill) => skill.name)).toEqual(['lesson']);
  });

  it('reads current name and soul for each extraction rather than caching identity', async () => {
    const { worker, runChild, getAgent } = await harness(fakeFeed(2));
    runChild.mockImplementationOnce(async ({ system }) => {
      expect(system).toContain('Extract. Atlas');
      expect(system).toContain('<soul>Initial soul</soul>');
      getAgent.mockReturnValue({ name: 'Kristine', soul: 'Updated soul' });
      return ok('{"operations": []}');
    });
    runChild.mockImplementationOnce(async ({ system }) => {
      expect(system).toContain('Extract. Kristine');
      expect(system).toContain('<soul>Updated soul</soul>');
      return ok('{"operations": []}');
    });
    expect(await worker.runOnce()).toBe('processed');
    expect(runChild).toHaveBeenCalledTimes(2);
    expect(getAgent).toHaveBeenCalledTimes(2);
    await worker.close();
  });

  it('reads current name and soul when consolidating after extraction', async () => {
    const { worker, runChild, getAgent } = await harness(fakeFeed(10));
    let extraction = 0;
    runChild.mockImplementation(async ({ system }) => {
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
    expect(runChild).toHaveBeenCalledTimes(11);
    expect(getAgent).toHaveBeenCalledTimes(11);
    await worker.close();
  });

  it('consolidates at weight twenty during a burst and never by elapsed time', async () => {
    const { worker, state, runChild, advanceClock } = await harness(
      fakeFeed(11),
    );
    let extraction = 0;
    runChild.mockImplementation(async ({ system }) =>
      ok(
        system?.startsWith('Extract.')
          ? createReply(`lesson-${extraction++}`)
          : '{"operations": []}',
      ),
    );
    await worker.runOnce();
    expect(runChild).toHaveBeenCalledTimes(12);
    expect(state.get()).toMatchObject({
      processedEpisodeCount: 11,
      pendingChangeWeight: 2,
      lastConsolidationEpisode: 10,
    });
    advanceClock(365 * 24 * 60 * 60_000);
    expect(await worker.runOnce()).toBe('idle');
    expect(runChild).toHaveBeenCalledTimes(12);
    await worker.close();
  });

  it('does not count unchanged rewrites or refresh their activity age', async () => {
    const { worker, skills, state, runChild } = await harness(fakeFeed(2));
    const put = vi.spyOn(skills, 'put');
    const setMetadata = vi.spyOn(skills, 'setMetadata');
    const initial = JSON.parse(createReply('lesson')) as {
      operations: object[];
    };
    runChild
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
    // The rewrite only cites the second episode; content stays untouched.
    expect(put).toHaveBeenCalledOnce();
    expect(setMetadata).toHaveBeenCalledOnce();
  });

  it('preserves new evidence on unchanged skills without refreshing their age or weight', async () => {
    const { worker, state, skills, registry, write, sources, runChild } =
      await harness(fakeFeed(2));
    const skill = {
      name: 'lesson',
      description: 'Use when lesson applies.',
      body: 'Do lesson.',
    };
    await write(skill, {
      metadata: { sourceEpisodes: [] },
      seed: {
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
      },
    });
    registry.tick();
    await state.update((draft) => {
      draft.processedEpisodeCount = 10;
    });
    const put = vi.spyOn(skills, 'put');
    runChild.mockImplementationOnce(async ({ tools, abortSignal }) => {
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
    expect(sources('lesson')).toEqual([episodeId(0), episodeId(1)]);
    expect(skills.get('lesson')).toMatchObject({
      updatedTurn: 0,
      updatedAt: '2026-10-01T00:00:00.000Z',
    });
    expect(state.get().pendingChangeWeight).toBe(0);
    expect(put).not.toHaveBeenCalled();
  });

  it('consumes a settled deferred revisit without submission or recounting progress', async () => {
    const { worker, state, runChild } = await harness(fakeFeed(2));
    runChild
      .mockResolvedValueOnce(ok('{"operations": [], "deferred": true}'))
      .mockResolvedValueOnce(ok('{"operations": []}'))
      .mockResolvedValueOnce(noSubmission());
    expect(await worker.runOnce()).toBe('processed');
    expect(state.get()).toMatchObject({
      processedEpisodeCount: 2,
      deferred: [],
      episodeFailures: {},
    });
    expect(await worker.runOnce()).toBe('idle');
    expect(runChild).toHaveBeenCalledTimes(3);
  });

  it('retains the partial marker when the primary page fills the character budget', async () => {
    const feed = fakeFeed(1, () => 'x'.repeat(60_000));
    const read = feed.readPage.bind(feed);
    feed.readPage = async (id, options) => {
      const page = await read(id, options);
      return page ? { ...page, truncated: true } : null;
    };
    const { worker, runChild } = await harness(feed);
    await worker.runOnce();
    expect(runChild.mock.calls[0]?.[0].prompt).toContain(
      '[Partial episode: scan or character budget exhausted; omitted content is not evidence.]',
    );
  });

  it('retains weight from earlier persisted operations when a later write fails', async () => {
    const { worker, skills, state, runChild } = await harness(fakeFeed(1));
    const first = JSON.parse(createReply('first')) as { operations: object[] };
    const second = JSON.parse(createReply('second')) as {
      operations: object[];
    };
    runChild.mockResolvedValue(
      ok(
        JSON.stringify({
          operations: [...first.operations, ...second.operations],
        }),
      ),
    );
    const original = skills.put.bind(skills);
    vi.spyOn(skills, 'put').mockImplementation(async (name, ...rest) => {
      if (name === 'second') throw new Error('write failed');
      return original(name, ...rest);
    });
    expect(await worker.runOnce()).toBe('processed');
    expect(skills.list().map((skill) => skill.name)).toEqual(['first']);
    expect(state.get()).toMatchObject({
      pendingChangeWeight: 2,
      processedEpisodeCount: 1,
    });
  });

  it('persists deferred references and revisits only after newer progress without recounting', async () => {
    const { worker, state, sources, runChild, dataDir } = await harness(
      fakeFeed(2),
    );
    runChild
      .mockResolvedValueOnce(ok('{"operations": [], "deferred": true}'))
      .mockResolvedValueOnce(ok('{"operations": []}'))
      .mockResolvedValueOnce(ok(createReply('verified-fix')));
    await worker.runOnce();
    expect(runChild).toHaveBeenCalledTimes(3);
    expect(state.get()).toMatchObject({
      processedEpisodeCount: 2,
      cursor: episodeId(1),
      deferred: [],
      pendingChangeWeight: 2,
    });
    expect(sources('verified-fix')).toEqual([episodeId(0)]);
    const reloaded = createLearningState(dataDir);
    await reloaded.start();
    expect(reloaded.get().processedEpisodeCount).toBe(2);
    await worker.runOnce();
    expect(runChild).toHaveBeenCalledTimes(3);
  });

  it('spaces unsubmitted consolidation by ten episodes, not drain passes', async () => {
    const { worker, write, state, runChild } = await harness(fakeFeed(0));
    for (const name of ['one', 'two'])
      await write({ name, description: `Use when ${name}.`, body: name });
    await state.update((draft) => {
      draft.pendingChangeWeight = 20;
    });
    runChild.mockResolvedValue(noSubmission('provider unavailable'));
    await worker.runOnce();
    expect(state.get()).toMatchObject({
      pendingChangeWeight: 20,
      consolidationFailures: 0,
      nextConsolidationEpisode: 10,
    });
    await worker.runOnce();
    expect(runChild).toHaveBeenCalledTimes(1);
    await state.update((draft) => {
      draft.processedEpisodeCount = 10;
    });
    await worker.runOnce();
    expect(runChild).toHaveBeenCalledTimes(2);
    expect(state.get().nextConsolidationEpisode).toBe(20);
  });

  it('cancels in-flight investigation without committing or recording failures', async () => {
    const { worker, state, skills, runChild } = await harness(fakeFeed(2));
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    runChild.mockImplementation(async (args) => {
      started();
      await new Promise<void>((resolve) =>
        args.abortSignal?.addEventListener('abort', () => resolve(), {
          once: true,
        }),
      );
      return ok(createReply('late-proposal'));
    });
    const run = worker.runOnce();
    await ready;
    await worker.close();
    await run;
    expect(runChild).toHaveBeenCalledTimes(1);
    expect(skills.list()).toEqual([]);
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
    const { worker, state, skills, runChild } = await harness(feed);
    const run = worker.runOnce();
    await vi.waitFor(() => expect(reading).toBe(true));
    const closing = worker.close();
    release();
    await Promise.all([run, closing]);
    expect(runChild).not.toHaveBeenCalled();
    expect(skills.list()).toEqual([]);
    expect(state.get()).toMatchObject({
      cursor: null,
      processedEpisodeCount: 0,
      episodeFailures: {},
    });
  });

  it('does nothing while memory is unavailable', async () => {
    const { worker, runChild } = await harness(fakeFeed(3, undefined, false));
    expect(await worker.runOnce()).toBe('unavailable');
    expect(runChild).not.toHaveBeenCalled();
  });

  it('backfills only the newest episodes and records provenance', async () => {
    const total = INITIAL_BACKFILL_EPISODES + 5;
    const feed = fakeFeed(total);
    const { worker, skills, sources, state, runChild } = await harness(feed);
    runChild.mockResolvedValueOnce(ok(createReply('ask-first')));

    expect(await worker.runOnce()).toBe('processed');

    const firstBackfilled = total - INITIAL_BACKFILL_EPISODES;
    expect(feed.reads).toEqual(
      Array.from({ length: INITIAL_BACKFILL_EPISODES }, (_, offset) =>
        episodeId(firstBackfilled + offset),
      ),
    );
    expect(skills.list().map((skill) => skill.name)).toEqual(['ask-first']);
    const current = state.get();
    expect(sources('ask-first')).toEqual([episodeId(firstBackfilled)]);
    expect(current.cursor).toBe(
      episodeId(firstBackfilled + INITIAL_BACKFILL_EPISODES - 1),
    );
    expect(current.pendingChangeWeight).toBe(2);
    expect(current.processedEpisodeCount).toBe(INITIAL_BACKFILL_EPISODES);
  });

  it('pins the backfill window when the first episode fails', async () => {
    const total = INITIAL_BACKFILL_EPISODES + 5;
    const { worker, state, createChildSession } = await harness(
      fakeFeed(total),
    );
    createChildSession.mockRejectedValueOnce(new Error('Child startup failed'));

    expect(await worker.runOnce()).toBe('retry-later');
    expect(state.get().cursor).toBe(
      episodeId(total - INITIAL_BACKFILL_EPISODES - 1),
    );
  });

  it('carries provenance of merged skills over to the survivor', async () => {
    const { worker, write, sources, state, runChild } = await harness(
      fakeFeed(0),
    );
    // The survivor's source is newer, so plain concatenation is out of order.
    for (const [name, source] of [
      ['keep-me', episodeId(2)],
      ['drop-me', episodeId(1)],
    ] as const) {
      await write(
        { name, description: `Use when ${name}.`, body: 'Body.' },
        { metadata: { sourceEpisodes: [source] } },
      );
    }
    await state.update((draft) => {
      draft.cursor = episodeId(0);
      draft.pendingChangeWeight = CONSOLIDATE_CHANGE_WEIGHT;
    });
    runChild.mockResolvedValueOnce(
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
    expect(sources('keep-me')).toEqual([episodeId(1), episodeId(2)]);
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
    const { worker, state, createChildSession } = await harness(feed);
    createChildSession.mockRejectedValueOnce(new Error('Child startup failed'));

    expect(await worker.runOnce()).toBe('retry-later');
    expect(state.get().cursor).toBeNull();

    visible = INITIAL_BACKFILL_EPISODES + 5;
    expect(await worker.runOnce()).toBe('processed');
    expect(full.reads.slice(0, 2)).toEqual([episodeId(0), episodeId(0)]);
  });

  it('keeps the skill unchanged and consumes the episode when a registry write fails', async () => {
    const { worker, skills, write, state, runChild } = await harness(
      fakeFeed(1),
    );
    const before = await write({
      name: 'ask-first',
      description: 'Use when ask-first.',
      body: 'Old.',
    });
    vi.spyOn(skills, 'put').mockRejectedValueOnce(new Error('write failed'));
    runChild.mockResolvedValueOnce(
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

    expect(await worker.runOnce()).toBe('processed');
    expect(skills.get('ask-first')).toEqual(before);
    expect(state.get().cursor).toBe(episodeId(0));
    expect(state.get().episodeFailures).toEqual({});
  });

  it('retries an unavailable episode without advancing before a later successful read', async () => {
    const feed = fakeFeed(1);
    vi.spyOn(feed, 'readPage').mockResolvedValueOnce(null);
    const { worker, state, runChild } = await harness(feed);
    expect(await worker.runOnce()).toBe('retry-later');
    expect(state.get()).toMatchObject({
      cursor: null,
      processedEpisodeCount: 0,
      episodeFailures: { [episodeId(0)]: 1 },
    });
    expect(runChild).not.toHaveBeenCalled();
    expect(await worker.runOnce()).toBe('processed');
    expect(state.get()).toMatchObject({
      cursor: episodeId(0),
      processedEpisodeCount: 1,
      episodeFailures: {},
    });
    expect(runChild).toHaveBeenCalledTimes(1);
  });

  it('applies the retry ceiling to permanently unavailable episodes', async () => {
    const feed = fakeFeed(2);
    const read = feed.readPage.bind(feed);
    feed.readPage = async (id, options) =>
      id === episodeId(0) ? null : read(id, options);
    const { worker, state, runChild } = await harness(feed);
    for (let attempt = 1; attempt < MAX_FAILURES_PER_EPISODE; attempt++) {
      expect(await worker.runOnce()).toBe('retry-later');
      expect(state.get().cursor).toBeNull();
    }
    expect(await worker.runOnce()).toBe('processed');
    expect(state.get()).toMatchObject({
      cursor: episodeId(1),
      processedEpisodeCount: 2,
      episodeFailures: {},
    });
    expect(runChild).toHaveBeenCalledTimes(1);
  });

  it('preserves a deferred revisit when its page is temporarily unavailable', async () => {
    const feed = fakeFeed(2);
    const read = feed.readPage.bind(feed);
    let unavailable = false;
    feed.readPage = async (id, options) =>
      unavailable && id === episodeId(0) ? null : read(id, options);
    const { worker, state, runChild } = await harness(feed);
    runChild
      .mockResolvedValueOnce(ok('{"operations": [], "deferred": true}'))
      .mockImplementationOnce(async () => {
        unavailable = true;
        return ok('{"operations": []}');
      });
    expect(await worker.runOnce()).toBe('retry-later');
    expect(state.get()).toMatchObject({
      processedEpisodeCount: 2,
      deferred: [{ id: episodeId(0), after: episodeId(0), attempts: 0 }],
      episodeFailures: { [episodeId(0)]: 1 },
    });
    unavailable = false;
    expect(await worker.runOnce()).toBe('idle');
    expect(state.get()).toMatchObject({
      deferred: [],
      episodeFailures: {},
      processedEpisodeCount: 2,
    });
  });

  it('skips short episodes without a model call', async () => {
    const { worker, state, runChild } = await harness(
      fakeFeed(2, () => 'short'),
    );
    expect(await worker.runOnce()).toBe('processed');
    expect(runChild).not.toHaveBeenCalled();
    expect(state.get().cursor).toBe(episodeId(1));
  });

  it('retries child startup failures, then skips the episode', async () => {
    const { worker, state, createChildSession } = await harness(fakeFeed(1));
    createChildSession.mockRejectedValue(new Error('Child startup failed'));

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
    const { worker, state, runChild, logger } = await harness(feed);
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
    expect(runChild).toHaveBeenCalledTimes(1);
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
    const { worker, state, runChild } = await harness(feed);
    expect(await worker.runOnce()).toBe('retry-later');
    expect(state.get()).toMatchObject({
      cursor: null,
      processedEpisodeCount: 0,
      episodeFailures: { [episodeId(0)]: 1 },
    });
    expect(runChild).not.toHaveBeenCalled();
  });

  it('consumes a terminated child without retrying model outcomes', async () => {
    const { worker, state, runChild } = await harness(fakeFeed(1));
    runChild.mockRejectedValueOnce(new Error('Provider unavailable'));
    expect(await worker.runOnce()).toBe('processed');
    expect(state.get().cursor).toBe(episodeId(0));
    expect(state.get().episodeFailures).toEqual({});
  });

  it('consolidates after enough weighted changes', async () => {
    const { worker, skills, write, state, runChild } = await harness(
      fakeFeed(0),
    );
    for (const name of ['keep-me', 'drop-me']) {
      await write(
        { name, description: `Use when ${name}.`, body: 'Body.' },
        { metadata: { sourceEpisodes: [episodeId(0)] } },
      );
    }
    await state.update((draft) => {
      draft.cursor = episodeId(0);
      draft.pendingChangeWeight = CONSOLIDATE_CHANGE_WEIGHT;
    });
    runChild.mockResolvedValueOnce(
      ok(
        JSON.stringify({
          operations: [{ op: 'delete', name: 'drop-me', reason: 'duplicate' }],
        }),
      ),
    );

    expect(await worker.runOnce()).toBe('idle');
    expect(skills.list().map((skill) => skill.name)).toEqual(['keep-me']);
    expect(skills.get('drop-me')).toBeNull();
    expect(state.get().pendingChangeWeight).toBe(0);
    expect(state.get().lastConsolidationAt).toBe('2026-10-02T00:00:00.000Z');
  });

  it.each([0, 1])(
    'enforces the cap and spaces consolidation without submission, primary episodes: %i',
    async (count) => {
      const { worker, skills, write, state, runChild } = await harness(
        fakeFeed(count),
      );
      for (let index = 0; index <= MAX_SKILLS; index++)
        await write({
          name: `skill-${index}`,
          description: 'Use when x.',
          body: 'Body.',
        });
      runChild.mockImplementation(async ({ system }) => {
        if (system?.startsWith('Consolidate.'))
          throw new Error('provider exception');
        return ok('{"operations": []}');
      });
      expect(await worker.runOnce()).toBe(count ? 'processed' : 'idle');
      expect(skills.list()).toHaveLength(MAX_SKILLS);
      expect(state.get()).toMatchObject({
        consolidationFailures: 0,
        nextConsolidationEpisode: count + 10,
      });
      expect(worker.introspect().running).toBe(false);
    },
  );

  it('evicts least-recently-used skills above the cap', async () => {
    const { worker, skills, registry, write, state, runChild } = await harness(
      fakeFeed(0),
    );
    runChild.mockResolvedValue(noSubmission('provider down'));
    const names = Array.from(
      { length: MAX_SKILLS + 1 },
      (_, index) => `skill-${index}`,
    );
    // skill-0 is the only one last active in an earlier turn.
    for (const name of names) {
      await write({ name, description: 'Use when x.', body: 'Body.' });
      if (name === 'skill-0') registry.tick();
    }
    await state.update((draft) => {
      draft.cursor = episodeId(0);
    });

    expect(await worker.runOnce()).toBe('idle');
    expect(skills.list()).toHaveLength(MAX_SKILLS);
    expect(skills.get('skill-0')).toBeNull();
  });

  it('preserves historical recency of migrated skills when enforcing the cap', async () => {
    const { worker, skills, write, runChild } = await harness(fakeFeed(0));
    runChild.mockResolvedValue(noSubmission('provider down'));
    // Imports share one turn, so seeded dates decide; read count does not.
    for (let index = 0; index <= MAX_SKILLS; index++) {
      await write(
        { name: `skill-${index}`, description: 'Use when x.', body: 'Body.' },
        {
          seed: {
            createdAt: '2026-10-01T00:00:00.000Z',
            updatedAt: '2026-10-01T00:00:00.000Z',
            lastReadAt: index === 0 ? '2026-10-02T00:00:00.000Z' : null,
            readCount: index === 0 ? 1 : 100,
          },
        },
      );
    }
    await worker.runOnce();
    expect(skills.list()).toHaveLength(MAX_SKILLS);
    expect(skills.get('skill-0')).not.toBeNull();
  });

  it('does not overlap runs', async () => {
    const { worker, runChild } = await harness(fakeFeed(1));
    let release: (value: ChildReply) => void = () => {};
    runChild.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const first = worker.runOnce();
    const second = worker.runOnce();
    expect(second).toBe(first);
    await vi.waitFor(() => expect(runChild).toHaveBeenCalledTimes(1));
    release(ok('{"operations": []}'));
    expect(await first).toBe('processed');
  });

  it('close waits for the in-flight run', async () => {
    const { worker, state, runChild } = await harness(fakeFeed(1));
    let release: (value: ChildReply) => void = () => {};
    runChild.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    void worker.runOnce();
    await vi.waitFor(() => expect(runChild).toHaveBeenCalledTimes(1));
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
    expect(runChild.mock.calls[0]?.[0].abortSignal?.aborted).toBe(true);
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
    const { worker, runChild } = await harness(fakeFeed(1));
    worker.start();
    await vi.waitFor(() => expect(runChild).toHaveBeenCalledTimes(1));
    await worker.close();
  });
});
