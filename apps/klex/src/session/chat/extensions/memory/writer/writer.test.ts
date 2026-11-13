import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ModuleLogger } from '@stagewise/logger';

import { type ActivityHistory, activityOrdinal } from '@/activity-history';
import type { ExtensionDeps } from '@/session/chat/extensions/extension-api';
import type { ExtendedUIMessage } from '@/session/chat/message-types';
import type { ChildSessionHandle } from '@/session/types';
import { createSkillRegistry } from '@/skills';

import { createMemoryWriterExt } from './writer';

vi.mock('../system-prompt.md', () => ({ default: 'Memory writer' }));
const directories: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(closers.splice(0).map((close) => close()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
const id = (index: number) =>
  `history:${Buffer.from(JSON.stringify([index, 'test', String(index)])).toString('base64url')}`;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'memory-writer-'));
  directories.push(root);
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as ModuleLogger;
  const registry = createSkillRegistry({ dataDirectory: root, logger });
  await registry.start();
  registry.claimNamespace('io.stagewise/memory-writer', 'learning');
  const sources = Array.from({ length: 8 }, (_, index) => ({
    id: id(index),
    ordinal: index,
    bytes: 10,
    revision: 'test',
    persistedAt: '2026-11-12T10:00:00Z',
  }));
  let retained = sources.slice(0, 5);
  let notify = () => {};
  const activities = {
    subscribe: (listener: () => void) => {
      notify = listener;
      return () => {
        notify = () => {};
      };
    },
    latest: async () => retained.slice(-1),
    isAvailable: () => true,
    compareIds: (left: string, right: string) =>
      (activityOrdinal(left) ?? -1) - (activityOrdinal(right) ?? -1),
    manifest: async () => sources,
    listNeighbors: async (sourceId: string, count: number) =>
      sources
        .filter((source) => source.ordinal < (activityOrdinal(sourceId) ?? 0))
        .slice(-count)
        .reverse(),
    readPage: async (sourceId: string) => ({
      id: sourceId,
      text: `message-${activityOrdinal(sourceId)}`,
    }),
    resolveBoundary: async (ids: readonly string[]) =>
      sources.findLast((source) => ids.includes(String(source.ordinal)))?.id ??
      null,
    readRange: vi.fn(async (after: string | null, through: string) => {
      const selected = retained.filter(
        (source) =>
          source.ordinal > (activityOrdinal(after) ?? -1) &&
          source.ordinal <= (activityOrdinal(through) ?? -1),
      );
      selected.splice(2); // Force multiple chunks through the actual sequential drain.
      const last = selected.at(-1);
      if (!last) return null;
      return {
        id: last.id,
        firstSourceId: selected[0]?.id,
        sourceIds: selected.map((source) => source.id),
        text: selected
          .map(
            (source) =>
              `Source ${source.id} (2026-11-12)\nmessage-${source.ordinal}`,
          )
          .join('\n\n'),
        truncated: false,
      };
    }),
  } as unknown as ActivityHistory;
  const messages: ExtendedUIMessage[] = [];
  let terminated = false;
  const child = {
    sessionId: 'memory-child',
    inbox: {
      sendMessage: vi.fn((message: ExtendedUIMessage) =>
        messages.push(message),
      ),
    },
    getSessionInfo: () => ({ status: terminated ? 'terminated' : 'active' }),
    waitForIdle: vi.fn(async () => true),
    close: vi.fn(async () => {
      terminated = true;
    }),
  } as unknown as ChildSessionHandle;
  const createChildSession = vi.fn<ExtensionDeps['createChildSession']>(
    async (options) => {
      terminated = false;
      const toolsFactory = options.extensions?.find(
        (factory) => factory.identifier === 'io.stagewise/memory-writer-tools',
      );
      const tools = toolsFactory?.create({} as ExtensionDeps);
      vi.mocked(child.waitForIdle).mockImplementation(async () => {
        await tools?.onStepComplete?.({
          generation: {},
          shouldContinue: false,
        } as never);
        return true;
      });
      return child;
    },
  );
  const factory = createMemoryWriterExt({
    activities,
    legacyLearningDirectory: join(root, 'legacy'),
  });
  const deps = {
    sessionId: 'default',
    getDataDir: () => join(root, 'writer'),
    skills: registry.forNamespace('learning'),
    logger,
    config: { getModelSelection: () => [] },
    createChildSession,
  } as unknown as ExtensionDeps;
  const extension = factory.create(deps);
  closers.push(async () => {
    await extension.onClose?.();
    await registry.close();
  });
  const compact = (ids: string[]) => {
    retained = sources.slice(0, Number(ids.at(-1)) + 1);
    notify();
    extension.onCheckpointApplied?.({
      droppedMessageIds: ids,
      checkpointMessageId: 'checkpoint',
    });
  };
  const state = async () =>
    (await extension.introspect?.())?.state as {
      cursor: string | null;
      pendingThrough: string | null;
    };
  return {
    extension,
    compact,
    state,
    messages,
    createChildSession,
    child,
    terminate: () => {
      terminated = true;
    },
  };
}

describe('oldest-first memory writer', () => {
  it('catches up from oldest history at startup, reuses one child, and advances progress', async () => {
    const f = await fixture();
    await f.extension.onStart?.();
    await vi.waitFor(async () => expect((await f.state()).cursor).toBe(id(4)));
    expect(
      f.messages.map(
        (message) =>
          (message.parts[0] as { text: string }).text
            .split('<new-activities>\n')[1]
            ?.split('\n</new-activities>')[0],
      ),
    ).toEqual([
      '[0]\nmessage-0\n\n[1]\nmessage-1',
      '[2]\nmessage-2\n\n[3]\nmessage-3',
      '[4]\nmessage-4',
    ]);
    const input =
      (f.messages[0]?.parts[0] as { text: string } | undefined)?.text ?? '';
    expect(input).toMatch(/^<previous-activities>\n/);
    expect(input).toContain('message-0');
    expect(input).not.toContain('history:');
    f.compact(['5']);
    await vi.waitFor(async () => expect((await f.state()).cursor).toBe(id(5)));
    expect(f.createChildSession).toHaveBeenCalledOnce();
    const options = f.createChildSession.mock.calls[0]?.[0] as unknown as {
      name: string;
      extensions: { identifier: string }[];
    };
    expect(options.name).toBe('memory-writer');
    expect(f.createChildSession).toHaveBeenCalledWith(
      expect.objectContaining({
        modelPurpose: 'memory',
        fallbackModelPurposes: ['chat'],
        basePrompt: expect.stringContaining('History line format:'),
      }),
    );
    expect(options.extensions.map((extension) => extension.identifier)).toEqual(
      ['io.stagewise/context-compaction', 'io.stagewise/memory-writer-tools'],
    );
    await vi.waitFor(async () =>
      expect((await f.state()).pendingThrough).toBeNull(),
    );
  });
  it('keeps rejected ranges pending and retries them before newer work', async () => {
    const f = await fixture();
    await f.extension.onStart?.();
    await vi.waitFor(async () => expect((await f.state()).cursor).toBe(id(4)));
    vi.mocked(f.child.waitForIdle).mockImplementationOnce(async () => {
      return true; // Idle without successful completion must not advance progress.
    });
    vi.useFakeTimers();
    f.compact(['5']);
    await vi.waitFor(async () =>
      expect((await f.state()).pendingThrough).toBe(id(5)),
    );
    await vi.waitFor(() => expect(f.child.waitForIdle).toHaveBeenCalled());
    expect((await f.state()).cursor).toBe(id(4));
    f.compact(['6']);
    await vi.advanceTimersByTimeAsync(30_000);
    vi.useRealTimers();
    await vi.waitFor(async () => expect((await f.state()).cursor).toBe(id(6)));
    expect(f.createChildSession).toHaveBeenCalledOnce();
  });
  it('does not create a child after shutdown', async () => {
    const f = await fixture();
    await f.extension.onStart?.();
    await f.extension.onClose?.();
    f.compact(['4']);
    expect(f.createChildSession).not.toHaveBeenCalled();
  });
});
