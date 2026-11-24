import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ModuleLogger } from '@stagewise/logger';

import { type ActivityHistory, activityOrdinal } from '@/activity-history';
import type { ExtensionDeps } from '@/session/chat/extensions/extension-api';
import type { ExtendedUIMessage } from '@/session/chat/message-types';
import type { ChildSessionHandle } from '@/session/types';
import { createSkillRegistry } from '@/skills';

import { createEntityStore } from './entities';
import { createMemoryWriterExt, firstRunStart } from './writer';

vi.mock('./system-prompt.md', () => ({ default: 'Memory writer' }));
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
async function fixture(completion: 'normal' | 'failed' | 'skip' = 'normal') {
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
    persistedAt: new Date().toISOString(),
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
    manifest: async () => retained,
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
        startedAt: '2026-11-12T10:00:00.000Z',
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
  let complete = async () => {};
  const children: ChildSessionHandle[] = [];
  const child = {
    sessionId: 'memory-child',
    inbox: {
      sendMessage: vi.fn((message: ExtendedUIMessage) =>
        messages.push(message),
      ),
    },
    getSessionInfo: () => ({ status: terminated ? 'terminated' : 'active' }),
    waitForIdle: vi.fn(async () => {
      await complete();
      return true;
    }),
    close: vi.fn(async () => {
      terminated = true;
    }),
  } as unknown as ChildSessionHandle;
  const createChildSession = vi.fn<ExtensionDeps['createChildSession']>(
    async (options) => {
      for (const previous of children)
        expect(previous.close).toHaveBeenCalledOnce();
      terminated = false;
      const toolsFactory = options.extensions?.find(
        (factory) => factory.identifier === 'io.stagewise/memory-writer-tools',
      );
      const tools = toolsFactory?.create({} as ExtensionDeps);
      complete = async () => {
        if (completion !== 'skip') {
          await tools?.onStepComplete?.({
            generation: {},
            shouldContinue: true,
          } as never);
        }
        if (completion === 'failed') {
          await tools?.onStepComplete?.({
            generation: null,
            shouldContinue: true,
            generationFailed: true,
          } as never);
        }
        await tools?.onStepComplete?.({
          generation: null,
          shouldContinue: false,
        } as never);
      };
      let closed = false;
      const handle = {
        ...child,
        sessionId: `memory-child-${children.length}`,
        // Own inbox per child, so a reused child would be visible.
        inbox: {
          sendMessage: vi.fn(
            (...args: Parameters<ChildSessionHandle['inbox']['sendMessage']>) =>
              child.inbox.sendMessage(...args),
          ),
        },
        getSessionInfo: () => ({ status: closed ? 'terminated' : 'active' }),
        close: vi.fn(async () => {
          closed = true;
        }),
      } as unknown as ChildSessionHandle;
      children.push(handle);
      return handle;
    },
  );
  const factory = createMemoryWriterExt({
    activities,
    skillReader: registry,
    legacyLearningDirectory: join(root, 'legacy'),
  });
  const deps = {
    sessionId: 'default',
    getDataDir: () => join(root, 'extensions/io.stagewise/memory'),
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
    root,
    registry,
    logger,
    extension,
    compact,
    state,
    messages,
    createChildSession,
    child,
    children,
    activities,
    terminate: () => {
      terminated = true;
    },
  };
}

describe('oldest-first memory writer', () => {
  it('limits a first run to the newest 21 days and 3,000 messages', () => {
    const now = Date.parse('2026-11-16T12:00:00Z');
    const sources = (ages: number[]) =>
      ages.map((days, index) => ({
        id: id(index),
        persistedAt: new Date(now - days * 86_400_000).toISOString(),
      }));
    expect(firstRunStart(sources([20, 0]), now)).toEqual({
      cursor: null,
      skipped: 0,
    });
    expect(firstRunStart(sources([23, 22, 20, 0]), now)).toEqual({
      cursor: id(1),
      skipped: 2,
    });
    expect(firstRunStart(sources(Array(3_002).fill(0)), now)).toEqual({
      cursor: id(1),
      skipped: 2,
    });
    expect(firstRunStart(sources([22]), now)).toEqual({
      cursor: id(0),
      skipped: 1,
    });
  });
  it('reports broken startup references and blocks deletion of referenced skills', async () => {
    const f = await fixture();
    await f.registry.replaceTemplateSkills([
      { name: 'deploy', description: 'Deploy', body: 'Deploy safely.' },
    ]);
    const store = createEntityStore(
      join(f.root, 'extensions/io.stagewise/memory/entities'),
    );
    await store.start();
    const missing = 'project/Missing';
    const entity = await store.create(
      {
        name: 'Project',
        entityType: 'project',
        loadOn: [],
        relatedTo: [
          {
            target: { kind: 'skill', id: 'templates/deploy' },
            relationship: 'uses',
          },
          {
            target: { kind: 'entity', id: missing },
            relationship: 'uses',
          },
          {
            target: { kind: 'skill', id: 'templates/missing' },
            relationship: 'uses',
          },
        ],
      },
      { General: [{ text: 'Project facts', sources: [], history: [] }] },
    );
    await f.extension.onStart?.();
    expect((await f.extension.introspect?.())?.brokenReferences).toEqual([
      {
        entityId: entity.id,
        target: { kind: 'entity', id: missing },
      },
      {
        entityId: entity.id,
        target: { kind: 'skill', id: 'templates/missing' },
      },
    ]);
    expect(f.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ brokenReferences: expect.any(Array) }),
      expect.any(String),
    );
    await expect(f.registry.delete('templates/deploy')).rejects.toThrow(
      `referenced by entities ${entity.id}`,
    );
    await expect(
      f.registry.replaceTemplateSkills([
        { name: 'new', description: 'New', body: 'New skill' },
      ]),
    ).rejects.toThrow('Cannot delete');
    expect(f.registry.get('templates/new')).toBeNull();
    expect(f.registry.get('templates/deploy')).not.toBeNull();
    await f.extension.onClose?.();
    expect(await f.registry.delete('templates/deploy')).toBe(true);
  });
  it('pauses instead of failing the session when stored notes are invalid', async () => {
    const f = await fixture();
    const folder = join(
      f.root,
      'extensions/io.stagewise/memory/entities/person',
    );
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'broken.md'), 'not an entity');
    await expect(f.extension.onStart?.()).resolves.toBeUndefined();
    expect(f.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(Error) }),
      'Memory writer failed to start; paused until next start',
    );
    expect((await f.extension.introspect?.())?.ready).toBe(false);
    expect(f.createChildSession).not.toHaveBeenCalled();
  });
  it('catches up oldest-first with one fresh child and one input per chunk', async () => {
    const f = await fixture();
    await f.extension.onStart?.();
    expect(await f.extension.introspect?.()).toMatchObject({
      dataDirectory: join(f.root, 'extensions/io.stagewise/memory'),
      entitiesDirectory: join(
        f.root,
        'extensions/io.stagewise/memory/entities',
      ),
    });
    await vi.waitFor(async () => expect((await f.state()).cursor).toBe(id(4)));
    expect(
      f.messages.map(
        (message) =>
          (message.parts[0] as { text: string }).text
            .split('<new-activities date="2026-11-12">\n')[1]
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
    expect(f.createChildSession).toHaveBeenCalledTimes(4);
    expect(f.children.map((child) => child.sessionId)).toEqual([
      'memory-child-0',
      'memory-child-1',
      'memory-child-2',
      'memory-child-3',
    ]);
    for (const child of f.children) {
      expect(child.close).toHaveBeenCalledOnce();
      expect(child.inbox.sendMessage).toHaveBeenCalledOnce();
    }
    expect(f.child.inbox.sendMessage).toHaveBeenCalledTimes(4);
    expect((await f.extension.introspect?.())?.childSessionId).toBeNull();
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
  it.each(['failed', 'skip'] as const)(
    'does not advance after a %s completion followed by a clean skip',
    async (completion) => {
      const f = await fixture(completion);
      await f.extension.onStart?.();
      await vi.waitFor(() =>
        expect(f.logger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ error: expect.any(Error) }),
          'Memory writer failed; retrying oldest pending range',
        ),
      );
      expect((await f.state()).cursor).toBeNull();
      expect(f.createChildSession).toHaveBeenCalledTimes(1);
      expect(f.children[0]?.close).toHaveBeenCalledOnce();
    },
  );
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
    expect(f.createChildSession).toHaveBeenCalledTimes(5);
    for (const child of f.children) expect(child.close).toHaveBeenCalledOnce();
  });
  it('sends a chunk only once while its child continues working', async () => {
    const f = await fixture();
    vi.mocked(f.child.waitForIdle).mockResolvedValueOnce(false);
    await f.extension.onStart?.();
    await vi.waitFor(async () => expect((await f.state()).cursor).toBe(id(4)));
    expect(f.createChildSession).toHaveBeenCalledTimes(3);
    expect(f.child.waitForIdle).toHaveBeenCalledTimes(4);
    expect(f.child.inbox.sendMessage).toHaveBeenCalledTimes(3);
    for (const child of f.children) expect(child.close).toHaveBeenCalledOnce();
  });
  it('preserves literal quotes and markup in input and uses smaller history budgets', async () => {
    const f = await fixture();
    vi.mocked(f.activities.readRange).mockResolvedValueOnce({
      id: id(4),
      firstSourceId: id(4),
      sourceIds: [id(4)],
      startedAt: '2026-11-12',
      endedAt: '2026-11-12',
      recordCount: 1,
      offset: 0,
      nextOffset: null,
      scannedBytes: 100,
      text: `Source ${id(4)} (2026-11-12)\nUser: "quoted" & <tag> 'text'\n\nSource ${id(5)} (2026-11-13T08:00:00.000Z)\nUser: next day`,
      truncated: false,
    });
    const neighbors = vi.spyOn(f.activities, 'listNeighbors');
    const page = vi.spyOn(f.activities, 'readPage');
    page.mockResolvedValue({
      id: id(3),
      text: 'Previous "quote" & value',
      startedAt: null,
      endedAt: null,
      offset: 0,
      nextOffset: null,
      scannedBytes: 100,
      truncated: false,
    });
    await f.extension.onStart?.();
    await vi.waitFor(async () => expect((await f.state()).cursor).toBe(id(4)));
    const input =
      (f.messages[0]?.parts[0] as { text: string } | undefined)?.text ?? '';
    expect(input).toContain(`User: "quoted" & <tag> 'text'`);
    expect(input).toContain('Previous "quote" & value');
    expect(input).not.toContain('&quot;');
    expect(input).toContain(
      `<new-activities date="2026-11-12">\n[4]\nUser: "quoted"`,
    );
    expect(input).toContain('[5] 2026-11-13\nUser: next day');
    expect(f.activities.readRange).toHaveBeenCalledWith(
      null,
      id(4),
      60_000,
      true,
      expect.any(Function),
    );
    expect(neighbors).toHaveBeenCalledWith(id(4), 2);
    expect(page).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ limit: 1_200 }),
    );
  });
  it('does not create a child after shutdown', async () => {
    const f = await fixture();
    await f.extension.onStart?.();
    await f.extension.onClose?.();
    f.compact(['4']);
    expect(f.createChildSession).not.toHaveBeenCalled();
  });
});
