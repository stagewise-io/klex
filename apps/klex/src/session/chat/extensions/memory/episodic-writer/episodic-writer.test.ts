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
import { LINES_FORMAT_PROMPT } from '@/session/chat/utils/history-view';
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
vi.mock('../retrieval/retrieval-prompt.md', () => ({ default: 'Retrieve.' }));
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

function configWithMemoryModels(count: number) {
  const entries = Array.from({ length: count }, (_, i) => ({
    providerId: 'test',
    modelId: `model-${i}`,
  }));
  return {
    get: () => ({ modelSelection: { memory: entries, chat: [] } }),
    getModelSelection: vi.fn((purpose: string) =>
      purpose === 'memory' ? entries : [],
    ),
  } as unknown as ExtensionDeps['config'];
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
        kind: 'child' as const,
        parentId: 'default',
        modelPurpose: 'memory' as const,
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
  } as unknown as ChildSessionHandle;
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
  it('writes exact timestamped lines in a UTC date folder', async () => {
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
    for (const entry of entries) await store.store(entry);

    expect(files(root)).toEqual(['2026-09-18/1-14-05.md']);
    expect(readFileSync(join(root, '2026-09-18', '1-14-05.md'), 'utf-8')).toBe(
      `${episodeFrontmatter}- 14:05: opened PR\n- 14:05: user may decline\n- 14:05: PR is 42\n- 14:05: slack user U1 = Glenn\n- 14:05: retry later\n`,
    );
  });

  it('appends to an episode without rewriting frontmatter', async () => {
    const root = directory();
    const store = new EpisodeStore({
      episodicDir: root,
      onResetRequired: vi.fn(),
      timezone: 'UTC',
    });
    await store.store({ data: 'first', time: '14:05' });
    const path = join(root, '2026-09-18', '1-14-05.md');
    writeFileSync(
      path,
      '---\nanalyzed: true\ncustom: preserved\n---\n\n- 14:05: first\n',
      'utf-8',
    );

    await store.store({ data: 'second', time: '14:06' });

    // Append-only: frontmatter is not rewritten on append.
    // The new entry is added below the existing content.
    expect(readFileSync(path, 'utf-8')).toBe(
      '---\nanalyzed: true\ncustom: preserved\n---\n\n- 14:05: first\n- 14:06: second\n',
    );
  });

  it('skips duplicate entries within a day, including after restart', async () => {
    const root = directory();
    const first = new EpisodeStore({
      episodicDir: root,
      onResetRequired: vi.fn(),
      timezone: 'UTC',
    });

    await first.store({ data: 'User prefers German', time: '14:05' });
    await first.store({
      data: '  user PREFERS   German  ',
      time: '14:05',
    });
    first.close();

    const restarted = new EpisodeStore({
      episodicDir: root,
      onResetRequired: vi.fn(),
      timezone: 'UTC',
    });
    await restarted.store({
      data: 'User prefers German',
      time: '14:05',
    });
    await restarted.store({ data: 'User prefers tea', time: '14:05' });

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

  it('files each entry in the UTC date folder matching its converted instant', async () => {
    const root = directory();
    const store = new EpisodeStore({
      episodicDir: root,
      onResetRequired: vi.fn(),
      timezone: 'Europe/Berlin',
    });

    // now = 2026-09-18T14:05 UTC → Berlin 16:05.
    // 23:50 local → 21:50 UTC same day (Sept 18).
    // 00:10 local → 22:10 UTC previous day (Sept 17).
    await store.store({ data: 'late', time: '23:50' });
    await store.store({ data: 'early morning', time: '00:10' });
    await store.store({ data: 'same minute', time: '00:10' });

    expect(files(root).sort()).toEqual([
      '2026-09-17/1-22-10.md',
      '2026-09-18/1-21-50.md',
    ]);
    expect(readFileSync(join(root, '2026-09-18', '1-21-50.md'), 'utf-8')).toBe(
      `${episodeFrontmatter}- 21:50: late\n`,
    );
    expect(readFileSync(join(root, '2026-09-17', '1-22-10.md'), 'utf-8')).toBe(
      `${episodeFrontmatter}- 22:10: early morning\n- 22:10: same minute\n`,
    );
  });

  it('closes and reopens the episode when entries cross UTC midnight', async () => {
    const root = directory();
    let now = new Date('2026-09-18T23:30:00.000Z');
    const store = new EpisodeStore({
      episodicDir: root,
      now: () => now,
      onResetRequired: vi.fn(),
      timezone: 'UTC',
    });

    await store.store({ data: 'before midnight', time: '23:59' });
    // Advance to the next UTC day so 00:01 local maps to Sept 19.
    now = new Date('2026-09-19T00:05:00.000Z');
    await store.store({ data: 'after midnight', time: '00:01' });

    expect(files(root).sort()).toEqual([
      '2026-09-18/1-23-59.md',
      '2026-09-19/1-00-01.md',
    ]);
    expect(readFileSync(join(root, '2026-09-18', '1-23-59.md'), 'utf-8')).toBe(
      `${episodeFrontmatter}- 23:59: before midnight\n`,
    );
    expect(readFileSync(join(root, '2026-09-19', '1-00-01.md'), 'utf-8')).toBe(
      `${episodeFrontmatter}- 00:01: after midnight\n`,
    );
  });

  it('handles west-of-UTC timezone where local evening maps to next UTC day', async () => {
    const root = directory();
    const now = new Date('2026-09-18T22:05:00.000Z');
    const store = new EpisodeStore({
      episodicDir: root,
      now: () => now,
      onResetRequired: vi.fn(),
      timezone: 'America/New_York',
    });

    // now = 2026-09-18T22:05 UTC → NY 18:05 (EDT, UTC-4).
    // 19:00 local → 23:00 UTC same day (Sept 18).
    // 20:00 local → 00:00 UTC next day (Sept 19).
    await store.store({ data: 'evening', time: '19:00' });
    await store.store({ data: 'late evening', time: '20:00' });

    expect(files(root).sort()).toEqual([
      '2026-09-18/1-23-00.md',
      '2026-09-19/1-00-00.md',
    ]);
  });

  it('deduplicates across UTC-date boundary using the converted instant', async () => {
    const root = directory();
    const store = new EpisodeStore({
      episodicDir: root,
      onResetRequired: vi.fn(),
      timezone: 'Europe/Berlin',
    });

    // 00:10 Berlin → 22:10 UTC on Sept 17.
    await store.store({ data: 'early morning', time: '00:10' });
    // Same entry again — should be deduped even though it is in the
    // previous UTC date folder relative to now().
    await store.store({ data: 'early morning', time: '00:10' });

    expect(files(root)).toEqual(['2026-09-17/1-22-10.md']);
    expect(store.introspect()).toMatchObject({ duplicateEntriesSkipped: 1 });
  });

  it('uses the highest daily index regardless of time and resets it at UTC midnight', async () => {
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

    await store.store({ data: 'same day', time: '01:00' });
    store.finishCurrentEpisode();
    await store.completeReset();
    now = new Date('2026-09-19T00:01:00.000Z');
    await store.store({ data: 'next day', time: '00:01' });

    expect(files(root)).toEqual([
      '2026-09-18/3-23-59.md',
      '2026-09-18/4-01-00.md',
      '2026-09-19/1-00-01.md',
    ]);
  });

  it('queues the next entry until reset after the entry limit', async () => {
    const root = directory();
    const onResetRequired = vi.fn();
    const store = new EpisodeStore({
      episodicDir: root,
      maxEntries: 2,
      onResetRequired,
      timezone: 'UTC',
    });

    await store.store({ data: 'one', time: '14:05' });
    await store.store({ data: 'two', time: '14:05' });
    await store.store({ data: 'three', time: '14:05' });
    expect(onResetRequired).toHaveBeenCalledOnce();
    expect(files(root)).toEqual(['2026-09-18/1-14-05.md']);

    await store.completeReset();
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
    await store.store({ data: 'one', time: '14:05' });

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(callback).toHaveBeenCalledOnce();
  });

  it('serializes concurrent store calls to prevent duplicate races', async () => {
    const root = directory();
    const store = new EpisodeStore({
      episodicDir: root,
      onResetRequired: vi.fn(),
      timezone: 'UTC',
    });

    // Without serialization, both calls could pass the duplicate check
    // before either adds the fingerprint.
    await Promise.all([
      store.store({ data: 'duplicate', time: '14:05' }),
      store.store({ data: 'duplicate', time: '14:05' }),
    ]);

    const content = readFileSync(
      join(root, '2026-09-18', '1-14-05.md'),
      'utf-8',
    );
    const entries = content.split('\n').filter((line) => line.startsWith('- '));
    expect(entries).toEqual(['- 14:05: duplicate']);
    expect(store.introspect()).toMatchObject({ duplicateEntriesSkipped: 1 });
    store.close();
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
        config: configWithMemoryModels(1),
        createChildSession,
        getDataDir: () =>
          join(directory(), 'extensions', 'io.stagewise', 'memory'),
        logger: logger(),
      },
      'Europe/Berlin',
    );
    const firstOptions = createChildSession.mock.calls[0]?.[0];
    expect(firstOptions?.basePrompt).toBe(
      `Remember.\n\n${LINES_FORMAT_PROMPT}`,
    );
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
        text: 'context github',
      }),
    ).toEqual([{ type: 'text', text: 'context github' }]);
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
      basePrompt: `Remember.\n\n${LINES_FORMAT_PROMPT}`,
      modelPurpose: 'memory',
    });
    expect(second.inbox.sendMessage).toHaveBeenCalledWith(
      message,
      expect.anything(),
    );
    expect(writer.sessionId).toBe('second');
    await writer.close();
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
        config: configWithMemoryModels(1),
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
    await writer.close();
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
        config: configWithMemoryModels(1),
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
    await writer.close();
  });

  it('falls back to chat models when memory models are empty', async () => {
    const createChildSession = vi
      .fn<ExtensionDeps['createChildSession']>()
      .mockResolvedValue(child('fb'));
    const writer = await createEpisodicWriter(
      {
        config: configWithMemoryModels(0),
        createChildSession,
        getDataDir: () => directory(),
        logger: logger(),
      },
      'UTC',
    );

    expect(createChildSession).toHaveBeenCalledOnce();
    expect(createChildSession.mock.calls[0]?.[0]).toMatchObject({
      modelPurpose: 'chat',
    });
    await writer.close();
  });

  it('uses memory models when they are configured', async () => {
    const createChildSession = vi
      .fn<ExtensionDeps['createChildSession']>()
      .mockResolvedValue(child('mem'));
    const writer = await createEpisodicWriter(
      {
        config: configWithMemoryModels(1),
        createChildSession,
        getDataDir: () => directory(),
        logger: logger(),
      },
      'UTC',
    );

    expect(createChildSession).toHaveBeenCalledOnce();
    expect(createChildSession.mock.calls[0]?.[0]).toMatchObject({
      modelPurpose: 'memory',
    });
    await writer.close();
  });
});
