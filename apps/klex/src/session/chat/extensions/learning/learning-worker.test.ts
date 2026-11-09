import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ModuleLogger } from '@stagewise/logger';

import { type ActivityHistory, activityOrdinal } from '@/activity-history';
import { createSkillRegistry } from '@/skills';

import {
  CONSOLIDATE_EVERY_RUNS,
  MAX_EPISODE_CHARACTERS,
  MAX_FAILURES_PER_EPISODE,
} from './learning-config';
import { createLearningState } from './learning-state';
import { createLearningWorker } from './learning-worker';
import { type ChildReply, childHarness, reply as ok } from './test-child';

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

/** Activity id of message `index`; its canonical message id is `String(index)`. */
function activityId(index: number): string {
  return `history:${Buffer.from(JSON.stringify([index, 'test', String(index)])).toString('base64url')}`;
}

function fakeFeed(
  count: number,
  textOf: (index: number) => string = (index) => `message-${index}-body`,
  available = true,
): ActivityHistory {
  const ids = Array.from({ length: count }, (_, index) => activityId(index));
  const ref = (id: string) => ({
    id,
    ordinal: ids.indexOf(id),
    persistedAt: '2026-10-01T10:00:00.000Z',
    bytes: textOf(ids.indexOf(id)).length,
    revision: 'test',
  });
  return {
    subscribe: () => () => undefined,
    listNeighbors: async () => [],
    readPage: async () => null,
    search: async () => ({
      matches: [],
      nextOffset: null,
      scannedBytes: 0,
      truncated: false,
    }),
    isAvailable: () => available,
    manifest: async () => ids.map(ref),
    latest: async (latest) => ids.slice(-latest).map(ref),
    compareIds: (left, right) =>
      (activityOrdinal(left) ?? -1) - (activityOrdinal(right) ?? -1),
    readPending: async () => null,
    resolveBoundary: async (messageIds) => {
      const wanted = new Set(messageIds);
      return ids.findLast((_, index) => wanted.has(String(index))) ?? null;
    },
    readRange: async (after, through, maxCharacters) => {
      const from = after === null ? 0 : (activityOrdinal(after) ?? -1) + 1;
      const last = activityOrdinal(through) ?? -1;
      const selected: number[] = [];
      let size = 0;
      for (let index = from; index <= last && index < count; index++) {
        const length = textOf(index).length;
        if (selected.length && size + length > maxCharacters) break;
        selected.push(index);
        size += length;
      }
      if (!selected.length) return null;
      return {
        id: ids[selected.at(-1)!]!,
        firstSourceId: ids[selected[0]!]!,
        sourceIds: selected.map((index) => ids[index]!).slice(-6),
        startedAt: '2026-10-01T10:00:00.000Z',
        endedAt: '2026-10-01T10:30:00.000Z',
        recordCount: selected.length,
        origins: [],
        text: selected.map(textOf).join('\n'),
        offset: 0,
        nextOffset: null,
        scannedBytes: size,
        truncated: false,
      };
    },
  };
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

async function harness(feed: ActivityHistory) {
  const dataDir = await temporaryDirectory('klex-learning-worker-');
  const registryDir = await temporaryDirectory('klex-learning-registry-');
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as ModuleLogger;
  const registry = createSkillRegistry({ dataDirectory: registryDir, logger });
  await registry.start();
  registry.claimNamespace('io.stagewise/learning', 'learning');
  const skills = registry.forNamespace('learning');
  const state = createLearningState(dataDirectory(dataDir));
  await state.start();
  const { runChild, createChildSession } = childHarness();
  const worker = createLearningWorker({
    activities: feed,
    skills,
    state,
    createChildSession,
    getModelPurpose: () => 'memory',
    getAgent: () => ({ name: 'Atlas', soul: 'Initial soul' }),
    logger,
  });
  return { worker, skills, state, runChild, createChildSession };
}

function dataDirectory(directory: string): string {
  return directory;
}

function noSubmissionReply(): ChildReply {
  return { text: 'No submission.', submit: false };
}

const isConsolidation = (system: string) => system.startsWith('Consolidate.');

describe('learning worker (compaction-triggered)', () => {
  it('learns from exactly the dropped range and advances the cursor', async () => {
    const { worker, state, runChild } = await harness(fakeFeed(6));
    worker.start();
    await worker.onCompaction(['3', '4']);
    expect(runChild).toHaveBeenCalledOnce();
    const prompt = runChild.mock.calls[0]![0].prompt;
    expect(prompt).toContain('message-3-body');
    expect(prompt).toContain('message-4-body');
    expect(prompt).not.toContain('message-1-body');
    expect(prompt).not.toContain('message-5-body');
    expect(state.get().cursor).toBe(activityId(4));
  });

  it('starts a fresh cursor at the dropped range instead of all history', async () => {
    const { worker, state, runChild } = await harness(fakeFeed(6));
    worker.start();
    expect(state.get().cursor).toBeNull();
    await worker.onCompaction(['3']);
    for (const [task] of runChild.mock.calls) {
      expect(task.prompt).not.toContain('message-0-body');
      expect(task.prompt).not.toContain('message-2-body');
    }
  });

  it('covers a later compaction from the previous cursor', async () => {
    const { worker, state, runChild } = await harness(fakeFeed(8));
    worker.start();
    await worker.onCompaction(['2']);
    await worker.onCompaction(['5']);
    expect(runChild).toHaveBeenCalledTimes(2);
    const second = runChild.mock.calls[1]![0].prompt;
    expect(second).toContain('message-3-body');
    expect(second).toContain('message-5-body');
    expect(second).not.toContain('message-2-body');
    expect(state.get().cursor).toBe(activityId(5));
  });

  it('splits a range above the chunk limit into several passes', async () => {
    const big = Math.floor(MAX_EPISODE_CHARACTERS * 0.7);
    const feed = fakeFeed(4, (index) => `m${index}`.padEnd(big, '.'));
    const { worker, state, runChild } = await harness(feed);
    worker.start();
    await worker.onCompaction(['0', '1', '2']);
    // One message per chunk because two never fit together.
    expect(runChild).toHaveBeenCalledTimes(3);
    expect(state.get().cursor).toBe(activityId(2));
  });

  it('collapses compactions that arrive during a run onto the newest boundary', async () => {
    const { worker, state, runChild } = await harness(fakeFeed(6));
    worker.start();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    runChild.mockImplementationOnce(async () => {
      await gate;
      return noSubmissionReply();
    });
    const first = worker.onCompaction(['1']);
    await vi.waitFor(() => expect(runChild).toHaveBeenCalledTimes(1));
    const second = worker.onCompaction(['4']);
    release();
    await Promise.all([first, second]);
    expect(runChild).toHaveBeenCalledTimes(2);
    expect(state.get().cursor).toBe(activityId(4));
  });

  it('consolidates only every Nth finished run', async () => {
    const { worker, skills, runChild } = await harness(fakeFeed(10));
    worker.start();
    for (const name of ['alpha', 'beta'])
      await skills.put(name, {
        description: `Use when ${name}.`,
        body: `Do ${name}.`,
      });
    runChild.mockResolvedValue(noSubmissionReply());
    for (let run = 1; run < CONSOLIDATE_EVERY_RUNS; run++) {
      await worker.onCompaction([String(run)]);
      expect(
        runChild.mock.calls.filter(([task]) => isConsolidation(task.system)),
      ).toHaveLength(0);
    }
    await worker.onCompaction([String(CONSOLIDATE_EVERY_RUNS)]);
    expect(
      runChild.mock.calls.filter(([task]) => isConsolidation(task.system)),
    ).toHaveLength(1);
  });

  it('retries a non-submitting consolidation only after another N jobs', async () => {
    const { worker, skills, runChild } = await harness(fakeFeed(20));
    worker.start();
    for (const name of ['alpha', 'beta'])
      await skills.put(name, {
        description: `Use when ${name}.`,
        body: `Do ${name}.`,
      });
    runChild.mockResolvedValue(noSubmissionReply());
    const consolidations = () =>
      runChild.mock.calls.filter(([task]) => isConsolidation(task.system))
        .length;
    for (let run = 1; run <= CONSOLIDATE_EVERY_RUNS; run++)
      await worker.onCompaction([String(run)]);
    expect(consolidations()).toBe(1);
    for (let run = 1; run < CONSOLIDATE_EVERY_RUNS; run++)
      await worker.onCompaction([String(CONSOLIDATE_EVERY_RUNS + run)]);
    expect(consolidations()).toBe(1);
    await worker.onCompaction([String(CONSOLIDATE_EVERY_RUNS * 2)]);
    expect(consolidations()).toBe(2);
  });

  it('does not start consolidation when shutdown happens during the cadence reset', async () => {
    const { worker, skills, state, runChild, createChildSession } =
      await harness(fakeFeed(10));
    worker.start();
    for (const name of ['alpha', 'beta'])
      await skills.put(name, {
        description: `Use when ${name}.`,
        body: `Do ${name}.`,
      });
    runChild.mockResolvedValue(noSubmissionReply());
    for (let run = 1; run < CONSOLIDATE_EVERY_RUNS; run++)
      await worker.onCompaction([String(run)]);
    const sessionsBefore = createChildSession.mock.calls.length;
    const original = state.update.bind(state);
    vi.spyOn(state, 'update').mockImplementation(async (mutate) => {
      const probe = structuredClone(state.get());
      probe.changedRunsSinceConsolidation = 1;
      mutate(probe);
      if (probe.changedRunsSinceConsolidation === 0) void worker.close();
      return original(mutate);
    });
    await worker.onCompaction([String(CONSOLIDATE_EVERY_RUNS)]);
    // Only the extraction child of the third job; no consolidation child.
    expect(createChildSession.mock.calls.length - sessionsBefore).toBe(1);
  });

  it('holds the cursor on failure and skips the chunk after repeated failures', async () => {
    const { worker, state, createChildSession } = await harness(fakeFeed(4));
    worker.start();
    createChildSession.mockRejectedValue(new Error('model unavailable'));
    await worker.onCompaction(['2']);
    expect(state.get().cursor).toBe(activityId(1));
    for (let attempt = 1; attempt < MAX_FAILURES_PER_EPISODE; attempt++)
      await worker.onCompaction(['2']);
    expect(state.get().cursor).toBe(activityId(2));
  });

  it('applies skills submitted by the extraction child', async () => {
    const { worker, skills, runChild } = await harness(fakeFeed(4));
    worker.start();
    runChild.mockResolvedValueOnce(
      ok(
        JSON.stringify({
          operations: [
            {
              op: 'create',
              name: 'learn-a',
              description: 'Use when learn-a applies.',
              body: 'Do learn-a.',
              reason: 'lesson',
            },
          ],
        }),
      ),
    );
    await worker.onCompaction(['2']);
    expect(skills.get('learn-a')).toMatchObject({ body: 'Do learn-a.' });
  });

  it('does nothing before start, after close, or without history', async () => {
    const early = await harness(fakeFeed(4));
    await early.worker.onCompaction(['2']);
    expect(early.runChild).not.toHaveBeenCalled();

    const closed = await harness(fakeFeed(4));
    closed.worker.start();
    await closed.worker.close();
    await closed.worker.onCompaction(['2']);
    expect(closed.runChild).not.toHaveBeenCalled();

    const unavailable = await harness(fakeFeed(4, undefined, false));
    unavailable.worker.start();
    await unavailable.worker.onCompaction(['2']);
    expect(unavailable.runChild).not.toHaveBeenCalled();
  });

  it('ignores compactions that drop nothing the history knows', async () => {
    const { worker, runChild } = await harness(fakeFeed(4));
    worker.start();
    await worker.onCompaction(['unknown']);
    expect(runChild).not.toHaveBeenCalled();
  });
});
