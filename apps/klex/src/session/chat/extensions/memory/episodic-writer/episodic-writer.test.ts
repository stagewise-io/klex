import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ExtensionDeps,
  ResolvedModel,
} from '@/session/chat/extensions/extension-api';
import type { ChildSessionHandle } from '@/session/types';

import { EpisodeStore, type MemoryEntry } from './episode-files';
import { createEpisodicWriter } from './episodic-writer';

vi.mock('@/session/chat/extensions/time/system-prompt.md', () => ({
  default: 'Time.',
}));
vi.mock(
  '@/session/chat/extensions/soul/system-prompt-part/no-soul-god.md',
  () => ({ default: 'No soul.' }),
);
vi.mock(
  '@/session/chat/extensions/soul/system-prompt-part/no-soul-regular.md',
  () => ({ default: 'No soul.' }),
);
vi.mock(
  '@/session/chat/extensions/soul/update-soul-tool-description.md',
  () => ({
    default: 'Update soul.',
  }),
);
vi.mock(
  '@/session/chat/extensions/audio-input-optimizer/audio-system-prompt.md',
  () => ({
    default: 'Describe audio.',
  }),
);
vi.mock(
  '@/session/chat/extensions/audio-input-optimizer/audio-tool-system-prompt.md',
  () => ({ default: 'Inspect audio.' }),
);
vi.mock(
  '@/session/chat/extensions/image-input-optimizer/vision-system-prompt.md',
  () => ({
    default: 'Describe image.',
  }),
);
vi.mock(
  '@/session/chat/extensions/image-input-optimizer/vision-tool-system-prompt.md',
  () => ({ default: 'Inspect image.' }),
);
vi.mock(
  '@/session/chat/extensions/context-compaction/compaction-prompt.md',
  () => ({ default: 'Summarize.' }),
);
vi.mock('./writer-prompt.md', () => ({ default: 'Remember.' }));

const directories: string[] = [];
const episodeFrontmatter = '---\nanalyzed: false\n---\n\n';
const model: ResolvedModel = {
  modelId: 'test:model',
  displayName: 'Test',
  contextSize: 128_000,
  inputCapabilities: {},
};

function logger() {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  };
}

function writerMessage(id: string, size = 16) {
  return {
    id,
    role: 'user' as const,
    parts: [{ type: 'text' as const, text: id.padEnd(size, '.') }],
  };
}

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'klex-episodes-'));
  directories.push(path);
  return path;
}

function files(root: string): string[] {
  return readdirSync(root, { recursive: true })
    .filter((entry) => String(entry).endsWith('.md'))
    .map(String)
    .sort();
}

function child(
  id: string,
  waitForIdle = vi.fn(async () => true),
  status: 'active' | 'terminated' | (() => 'active' | 'terminated') = 'active',
) {
  return {
    sessionId: id,
    inbox: {
      send: vi.fn(),
      sendMessage: vi.fn(),
      close: vi.fn(),
    },
    getMessages: vi.fn(() => []),
    getSessionInfo: vi.fn(() => {
      const currentStatus = typeof status === 'function' ? status() : status;
      return {
        id,
        status: currentStatus,
        runtimeState: currentStatus === 'active' ? 'idle' : 'terminated',
        model: { id: null, isFallback: false, fallbackIndex: 0 },
        usage: {
          chat: {
            latest: null,
            total: {
              inputTokens: 0,
              outputTokens: 0,
              inputCacheWriteTokens: 0,
              inputCacheReadTokens: 0,
            },
          },
          extensions: {},
        },
        turns: 0,
        steps: 0,
        messageCount: 0,
        createdAt: new Date().toISOString(),
      };
    }),
    close: vi.fn(async () => undefined),
    waitForIdle,
    createChildSession: vi.fn(),
  } as ChildSessionHandle;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-18T14:05:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe('episode store', () => {
  it('writes exact timestamped lines in a UTC date folder', () => {
    const root = directory();
    const store = new EpisodeStore({
      episodicDir: root,
      onResetRequired: vi.fn(),
      timezone: 'UTC',
    });

    const entries: MemoryEntry[] = [
      { data: 'opened PR', time: '14:05' },
      { data: 'user may decline', time: '14:05' },
      { data: 'PR is 42', time: '14:05' },
      { data: 'slack user U1 = Glenn', time: '14:05' },
      { data: 'retry later', time: '14:05' },
    ];
    for (const entry of entries) store.store(entry);

    expect(files(root)).toEqual(['2026-09-18/1-14-05.md']);
    expect(readFileSync(join(root, '2026-09-18', '1-14-05.md'), 'utf-8')).toBe(
      `${episodeFrontmatter}- 14:05: opened PR\n- 14:05: user may decline\n- 14:05: PR is 42\n- 14:05: slack user U1 = Glenn\n- 14:05: retry later\n`,
    );
  });

  it('resets analyzed to false whenever an episode is updated', () => {
    const root = directory();
    const store = new EpisodeStore({
      episodicDir: root,
      onResetRequired: vi.fn(),
      timezone: 'UTC',
    });
    store.store({ data: 'first', time: '14:05' });
    const path = join(root, '2026-09-18', '1-14-05.md');
    writeFileSync(
      path,
      '---\nanalyzed: true\ncustom: preserved\n---\n\n- 14:05: first\n',
      'utf-8',
    );

    store.store({ data: 'second', time: '14:06' });

    expect(readFileSync(path, 'utf-8')).toBe(
      '---\nanalyzed: false\ncustom: preserved\n---\n\n- 14:05: first\n- 14:06: second\n',
    );
  });

  it('skips duplicate entries within a day, including after restart', () => {
    const root = directory();
    const first = new EpisodeStore({
      episodicDir: root,
      onResetRequired: vi.fn(),
      timezone: 'UTC',
    });

    first.store({ data: 'User prefers German', time: '14:05' });
    first.store({
      data: '  user PREFERS   German  ',
      time: '14:05',
    });
    first.close();

    const restarted = new EpisodeStore({
      episodicDir: root,
      onResetRequired: vi.fn(),
      timezone: 'UTC',
    });
    restarted.store({
      data: 'User prefers German',
      time: '14:05',
    });
    restarted.store({ data: 'User prefers tea', time: '14:05' });

    expect(files(root)).toEqual([
      '2026-09-18/1-14-05.md',
      '2026-09-18/2-14-05.md',
    ]);
    expect(readFileSync(join(root, '2026-09-18', '1-14-05.md'), 'utf-8')).toBe(
      `${episodeFrontmatter}- 14:05: User prefers German\n`,
    );
    expect(readFileSync(join(root, '2026-09-18', '2-14-05.md'), 'utf-8')).toBe(
      `${episodeFrontmatter}- 14:05: User prefers tea\n`,
    );
    expect(first.introspect()).toMatchObject({ duplicateEntriesSkipped: 1 });
    expect(restarted.introspect()).toMatchObject({
      duplicateEntriesSkipped: 1,
    });
  });

  it('converts each local entry time independently and allows backward jumps', () => {
    const root = directory();
    const store = new EpisodeStore({
      episodicDir: root,
      onResetRequired: vi.fn(),
      timezone: 'Europe/Berlin',
    });

    store.store({ data: 'late', time: '23:50' });
    store.store({ data: 'clock moved back', time: '00:10' });
    store.store({ data: 'same minute', time: '00:10' });

    expect(readFileSync(join(root, '2026-09-18', '1-14-05.md'), 'utf-8')).toBe(
      `${episodeFrontmatter}- 21:50: late\n- 22:10: clock moved back\n- 22:10: same minute\n`,
    );
  });

  it('uses the highest daily index regardless of time and resets it at UTC midnight', () => {
    const root = directory();
    mkdirSync(join(root, '2026-09-18'));
    writeFileSync(join(root, '2026-09-18', '3-23-59.md'), 'old');
    let now = new Date('2026-09-18T01:00:00.000Z');
    const store = new EpisodeStore({
      episodicDir: root,
      now: () => now,
      onResetRequired: vi.fn(),
      timezone: 'UTC',
    });

    store.store({ data: 'same day', time: '01:00' });
    store.finishCurrentEpisode();
    store.completeReset();
    now = new Date('2026-09-19T00:01:00.000Z');
    store.store({ data: 'next day', time: '00:01' });

    expect(files(root)).toEqual([
      '2026-09-18/3-23-59.md',
      '2026-09-18/4-01-00.md',
      '2026-09-19/1-00-01.md',
    ]);
  });

  it('queues the next entry until reset after the entry limit', () => {
    const root = directory();
    const onResetRequired = vi.fn();
    const store = new EpisodeStore({
      episodicDir: root,
      maxEntries: 2,
      onResetRequired,
      timezone: 'UTC',
    });

    store.store({ data: 'one', time: '14:05' });
    store.store({ data: 'two', time: '14:05' });
    store.store({ data: 'three', time: '14:05' });
    expect(onResetRequired).toHaveBeenCalledOnce();
    expect(files(root)).toEqual(['2026-09-18/1-14-05.md']);

    store.completeReset();
    expect(files(root)).toEqual([
      '2026-09-18/1-14-05.md',
      '2026-09-18/2-14-05.md',
    ]);
    expect(readFileSync(join(root, '2026-09-18', '2-14-05.md'), 'utf-8')).toBe(
      `${episodeFrontmatter}- 14:05: three\n`,
    );
  });

  it('requests reset after one hour', async () => {
    const callback = vi.fn();
    const store = new EpisodeStore({
      episodicDir: directory(),
      onResetRequired: callback,
      timezone: 'UTC',
    });
    store.store({ data: 'one', time: '14:05' });

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(callback).toHaveBeenCalledOnce();
  });
});

describe('episodic writer owner', () => {
  it('exposes only memorize and replaces the child before buffered input', async () => {
    const firstIdle = Promise.withResolvers<boolean>();
    const first = child(
      'first',
      vi.fn(() => firstIdle.promise),
    );
    const second = child('second');
    const createChildSession = vi
      .fn<ExtensionDeps['createChildSession']>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const writer = await createEpisodicWriter(
      {
        createChildSession,
        getDataDir: () =>
          join(directory(), 'extensions', 'io.stagewise', 'memory'),
        logger: logger(),
      },
      'Europe/Berlin',
    );
    const firstOptions = createChildSession.mock.calls[0]?.[0];
    expect(firstOptions?.basePrompt).toBe('Remember.');
    expect(firstOptions?.modelPurpose).toBe('memory');
    expect(
      firstOptions?.extensions.map((extension) => extension.identifier),
    ).toEqual([
      'io.stagewise/name-loader',
      'io.stagewise/soul',
      'io.stagewise/context-compaction',
      'io.stagewise/memory-writer-input',
      'io.stagewise/image-input-optimizer',
      'io.stagewise/audio-input-optimizer',
      'io.stagewise/memorize',
    ]);
    const writerInputFactory = firstOptions?.extensions.find(
      (extension) =>
        extension.identifier === 'io.stagewise/memory-writer-input',
    );
    const writerInputExtension = writerInputFactory?.create(
      {} as ExtensionDeps,
    );
    expect(
      writerInputExtension?.dataPartTransformers?.['memory-writer-event']?.({
        ndjson: '{"type":"context"}',
      }),
    ).toEqual([{ type: 'text', text: '{"type":"context"}' }]);
    expect(
      writerInputExtension?.dataPartTransformers?.['memory-writer-image']?.({
        data: 'aW1hZ2U=',
        mediaType: 'image/png',
      }),
    ).toEqual([
      {
        type: 'file',
        data: { type: 'data', data: 'aW1hZ2U=' },
        mediaType: 'image/png',
      },
    ]);
    const memorizeFactory = firstOptions?.extensions.find(
      (extension) => extension.identifier === 'io.stagewise/memorize',
    );
    const toolExtension = memorizeFactory?.create({} as ExtensionDeps);
    const tools = toolExtension?.getTools?.(model) ?? {};
    expect(Object.keys(tools)).toEqual(['memorize']);
    const schema = tools.memorize?.inputSchema as {
      safeParse: (input: unknown) => { success: boolean };
    };
    expect(
      schema.safeParse({ data: 'remember this', time: '09:30' }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ data: 'remember this', time: '9:30' }).success,
    ).toBe(false);

    const finishing = writer.finishCurrentEpisode();
    const message = {
      id: 'context',
      role: 'user' as const,
      parts: [{ type: 'text' as const, text: 'new context' }],
    };
    const submitting = writer.submit(message);
    expect(second.inbox.sendMessage).not.toHaveBeenCalled();

    firstIdle.resolve(true);
    await finishing;
    await submitting;

    expect(first.close).toHaveBeenCalledOnce();
    expect(createChildSession).toHaveBeenCalledTimes(2);
    expect(createChildSession.mock.calls[1]?.[0]).toMatchObject({
      basePrompt: 'Remember.',
      modelPurpose: 'memory',
    });
    expect(second.inbox.sendMessage).toHaveBeenCalledWith(
      message,
      expect.anything(),
    );
    expect(writer.sessionId).toBe('second');
  });

  it('replaces a terminated writer and retries its in-flight input', async () => {
    let statusReadCount = 0;
    const first = child(
      'first',
      vi.fn(async () => false),
      () => (statusReadCount++ === 0 ? 'active' : 'terminated'),
    );
    const second = child('second');
    const createChildSession = vi
      .fn<ExtensionDeps['createChildSession']>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const writer = await createEpisodicWriter(
      {
        createChildSession,
        getDataDir: () => directory(),
        logger: logger(),
      },
      'UTC',
    );
    const message = writerMessage('recover');

    await writer.submit(message);
    expect(await writer.waitForIdle(1_000)).toBe(true);

    expect(first.inbox.sendMessage).toHaveBeenCalledWith(
      message,
      expect.anything(),
    );
    expect(second.inbox.sendMessage).toHaveBeenCalledWith(
      message,
      expect.anything(),
    );
    expect(writer.sessionId).toBe('second');
  });

  it('bounds buffered input and drops the oldest waiting messages first', async () => {
    const firstIdle = Promise.withResolvers<boolean>();
    const active = child(
      'active',
      vi.fn(() => firstIdle.promise),
    );
    const log = logger();
    const writer = await createEpisodicWriter(
      {
        createChildSession: vi.fn(async () => active),
        getDataDir: () => directory(),
        logger: log,
      },
      'UTC',
    );
    const messages = Array.from({ length: 5 }, (_, index) =>
      writerMessage(`message-${index + 1}`, 12_000),
    );

    for (const message of messages) await writer.submit(message);
    firstIdle.resolve(true);
    expect(await writer.waitForIdle(1_000)).toBe(true);

    expect(active.inbox.sendMessage).toHaveBeenCalledTimes(4);
    expect(
      vi
        .mocked(active.inbox.sendMessage)
        .mock.calls.map(([message]) => message.id),
    ).toEqual(['message-1', 'message-3', 'message-4', 'message-5']);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ droppedMessages: 1 }),
      expect.stringContaining('dropped oldest pending input'),
    );
  });
});
