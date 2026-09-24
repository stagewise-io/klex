import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChildSessionHandle } from '@/session/types';

import type { ExtendedUIMessage } from '../../message-types';
import {
  createDataPart,
  type Extension,
  type ExtensionDeps,
  type StepCompleteEvent,
} from '../extension-api';
import { createMemoryExt } from './memory';

vi.mock('@/local-data', () => ({
  inspectSqliteStore: vi.fn().mockResolvedValue({
    legacy: false,
    metadata: {
      store: 'episodic-search-index',
      schemaVersion: 1,
      compatibilityVersion: 1,
      minimumKlexVersion: '0.9.2',
      writtenByKlexVersion: 'test',
    },
  }),
  initializeSqliteStore: vi.fn().mockResolvedValue(undefined),
  migrateSqliteStore: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../time/system-prompt.md', () => ({ default: 'Time.' }));
vi.mock('./retrieval/retrieval-prompt.md', () => ({
  default: 'Retrieve memory.',
}));
vi.mock('./system-prompt-part.md', () => ({
  default: 'Memory system prompt.',
}));
vi.mock('./retrieval/search-index', async () => {
  const actual = await vi.importActual<
    typeof import('./retrieval/search-index')
  >('./retrieval/search-index');
  return {
    ...actual,
    EpisodicSearchIndex: vi.fn(function MockEpisodicSearchIndex() {
      return {
        start: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        getStatus: vi.fn().mockReturnValue('ready'),
        getState: vi.fn().mockReturnValue({
          status: 'ready',
          lastReconciledAt: null,
        }),
        clearOwner: vi.fn(),
      };
    }),
  };
});
vi.mock('../soul/system-prompt-part/no-soul-god.md', () => ({
  default: 'No soul.',
}));
vi.mock('../soul/system-prompt-part/no-soul-regular.md', () => ({
  default: 'No soul.',
}));
vi.mock('../soul/update-soul-tool-description.md', () => ({
  default: 'Update soul.',
}));
vi.mock('../audio-input-optimizer/audio-system-prompt.md', () => ({
  default: 'Describe audio.',
}));
vi.mock('../audio-input-optimizer/audio-tool-system-prompt.md', () => ({
  default: 'Inspect audio.',
}));
vi.mock('../image-input-optimizer/vision-system-prompt.md', () => ({
  default: 'Describe image.',
}));
vi.mock('../image-input-optimizer/vision-tool-system-prompt.md', () => ({
  default: 'Inspect image.',
}));
vi.mock('../context-compaction/compaction-prompt.md', () => ({
  default: 'Summarize the conversation.',
}));
vi.mock('./episodic-writer/writer-prompt.md', () => ({
  default: 'You are an episodic memory writer.',
}));

const completedStep: StepCompleteEvent = {
  shouldContinue: false,
  forceNextStep: false,
  fatalError: false,
  fatalErrorReason: null,
  generationFailed: false,
  generation: null,
  toolCalls: [],
  modelFallbackOccurred: false,
};

function textMessage(
  role: 'user' | 'assistant',
  id: string,
  text = id,
): ExtendedUIMessage {
  return { id, role, parts: [{ type: 'text', text }] };
}

function filteredUserMessage(id: string): ExtendedUIMessage {
  return {
    id,
    role: 'user',
    parts: [{ type: 'data-check', data: {} }],
  };
}

function contextMessage(
  content: Array<{ type: 'text'; text: string }>,
  id: string,
  sourceEnv = 'test',
): ExtendedUIMessage {
  return {
    id,
    role: 'user',
    parts: [
      {
        type: 'data-context',
        data: { sourceEnv, metadata: {}, content },
      } as never,
    ],
  };
}

function compactionMessage(id: string): ExtendedUIMessage {
  return {
    id,
    role: 'assistant',
    parts: [
      createDataPart('context-summary', { summary: 'compacted' }) as never,
    ],
  };
}

function createChild(
  options: {
    sendMessage?: ChildSessionHandle['inbox']['sendMessage'];
    sessionId?: string;
    waitForIdle?: ChildSessionHandle['waitForIdle'];
  } = {},
): ChildSessionHandle {
  const inbox: ChildSessionHandle['inbox'] = {
    send: vi.fn(),
    sendMessage: options.sendMessage ?? vi.fn(),
    close: vi.fn(),
  };
  return {
    sessionId: options.sessionId ?? 'writer',
    inbox,
    getMessages: vi.fn(() => []),
    getSessionInfo: vi.fn(() => ({
      name: 'episodic-memory-writer',
      extensionIdentifier: 'memory',
      kind: 'child' as const,
      parentId: 'default',
      modelPurpose: 'memory' as const,
      id: 'writer',
      status: 'active' as const,
      runtimeState: 'idle' as const,
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
    })),
    close: vi.fn(async () => undefined),
    waitForIdle:
      options.waitForIdle ?? vi.fn(async (_timeoutMs: number) => true),
    createChildSession: vi.fn(async () => {
      throw new Error('not used by memory tests');
    }),
  };
}

function createHarness(
  options: {
    history?: ExtendedUIMessage[];
    child?: ChildSessionHandle;
    createChildSession?: ExtensionDeps['createChildSession'];
    memoryWriteIntervalMs?: number;
    memoryWriteStepInterval?: number;
  } = {},
): {
  extension: Extension;
  history: ExtendedUIMessage[];
  child: ChildSessionHandle;
  retrievalChild: ChildSessionHandle;
  createChildSession: ExtensionDeps['createChildSession'];
  logger: {
    debug: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
  };
} {
  const history = options.history ?? [];
  const child = options.child ?? createChild();
  const retrievalChild = createChild({ sessionId: 'retrieval' });
  const createChildSession =
    options.createChildSession ??
    vi.fn().mockResolvedValueOnce(child).mockResolvedValue(retrievalChild);
  const logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  };
  const deps = createMemoryDeps({
    getHistory: () => [...history],
    createChildSession,
    getDataDir: () => '/tmp/klex-memory-test',
    config: {
      get: () => ({
        episodeFinishIdleTriggerTimeMs: 300_000,
        memoryWriteIntervalMs: options.memoryWriteIntervalMs ?? 60_000,
        memoryWriteStepInterval: options.memoryWriteStepInterval ?? 3,
        timezone: 'UTC',
      }),
      getModelSelection: vi.fn(() => [
        { providerId: 'test', modelId: 'test-model' },
      ]),
    } as unknown as ExtensionDeps['config'],
    logger,
  });

  return {
    extension: createMemoryExt({ timezone: 'UTC' }).create(deps),
    history,
    child,
    retrievalChild,
    createChildSession,
    logger,
  };
}

function createMemoryDeps(
  deps: Pick<
    ExtensionDeps,
    'config' | 'createChildSession' | 'getDataDir' | 'getHistory' | 'logger'
  >,
): ExtensionDeps {
  return deps as ExtensionDeps;
}

function state(extension: Extension): Record<string, unknown> {
  return extension.introspect?.() as Record<string, unknown>;
}

describe('memory extension', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates the writer during startup with its dedicated base prompt', async () => {
    const { extension, createChildSession } = createHarness();

    await extension.onStart?.();

    expect(createChildSession).toHaveBeenCalledTimes(2);
    expect(createChildSession).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        basePrompt: expect.stringContaining('episodic memory writer'),
        modelPurpose: 'memory',
      }),
    );
    expect(createChildSession).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        basePrompt: expect.stringContaining('Retrieve memory.'),
        modelPurpose: 'memory',
      }),
    );
    expect(extension.getTools?.({} as never)).toHaveProperty('recall');
  });

  it('logs and rethrows writer startup failure', async () => {
    const startupError = new Error('writer failed');
    const { extension, logger } = createHarness({
      createChildSession: vi.fn(async () => {
        throw startupError;
      }),
    });

    await expect(extension.onStart?.()).rejects.toBe(startupError);
    expect(logger.error).toHaveBeenCalledWith(
      { error: startupError },
      expect.stringContaining('Failed to start memory extension'),
    );
  });

  it('writes after three completed steps with pending history', async () => {
    const { extension, child, history } = createHarness({
      history: [contextMessage([{ type: 'text', text: 'ctx-0' }], 'u0')],
    });
    await extension.onStart?.();

    await extension.onStepComplete?.(completedStep);
    history.push(contextMessage([{ type: 'text', text: 'ctx-1' }], 'u1'));
    await extension.onStepComplete?.(completedStep);
    expect(child.inbox.sendMessage).not.toHaveBeenCalled();

    history.push(contextMessage([{ type: 'text', text: 'ctx-2' }], 'u2'));
    await extension.onStepComplete?.(completedStep);

    expect(child.inbox.sendMessage).toHaveBeenCalledOnce();
    expect(state(extension)).toMatchObject({
      lastProcessedMessageId: 'u2',
      pendingStepCount: 0,
      pendingUserMessageCount: 0,
    });
  });

  it('advances the cursor after buffering and retries inbox delivery', async () => {
    const sendMessage = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('inbox failed');
      })
      .mockImplementationOnce(() => undefined);
    const child = createChild({ sendMessage });
    const history = Array.from({ length: 50 }, (_, index) =>
      contextMessage([{ type: 'text', text: `ctx-${index}` }], `u${index}`),
    );
    const { extension, logger } = createHarness({ history, child });
    await extension.onStart?.();

    await extension.onStepComplete?.(completedStep);
    await extension.onStepComplete?.(completedStep);
    await extension.onStepComplete?.(completedStep);
    expect(state(extension)).toMatchObject({
      lastProcessedMessageId: 'u49',
      pendingUserMessageCount: 0,
    });

    await vi.advanceTimersByTimeAsync(1_000);

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(Error) }),
      expect.stringContaining('input remains buffered'),
    );
  });

  it('schedules another bounded flush when complete records remain', async () => {
    const history = Array.from({ length: 30 }, (_, index) =>
      textMessage('assistant', `a${index}`, `${index}-${'x'.repeat(500)}`),
    );
    const { extension, child } = createHarness({ history });
    await extension.onStart?.();

    await extension.onStepComplete?.(completedStep);
    await extension.onStepComplete?.(completedStep);
    await extension.onStepComplete?.(completedStep);

    expect(child.inbox.sendMessage).toHaveBeenCalledOnce();
    expect(state(extension)).toMatchObject({
      memoryWriteTimerActive: true,
    });
    expect(state(extension).lastProcessedMessageId).not.toBe('a29');

    await vi.advanceTimersByTimeAsync(60_000);

    expect(child.inbox.sendMessage).toHaveBeenCalledTimes(2);
    expect(state(extension)).toMatchObject({
      lastProcessedMessageId: 'a29',
      memoryWriteTimerActive: false,
    });
  });

  it('advances filtered-only deltas without sending heading-only input', async () => {
    const history = Array.from({ length: 50 }, (_, index) =>
      filteredUserMessage(`u${index}`),
    );
    const { extension, child } = createHarness({ history });
    await extension.onStart?.();

    await extension.onStepComplete?.(completedStep);
    await extension.onStepComplete?.(completedStep);
    await extension.onStepComplete?.(completedStep);

    expect(child.inbox.sendMessage).not.toHaveBeenCalled();
    expect(state(extension)).toMatchObject({
      lastProcessedMessageId: 'u49',
      pendingUserMessageCount: 0,
    });
  });

  it('writes assistant activity when compaction is detected', async () => {
    const history = [
      textMessage('assistant', 'assistant-work', 'important work'),
      compactionMessage('summary'),
    ];
    const { extension, child } = createHarness({ history });
    await extension.onStart?.();

    await extension.onStepComplete?.(completedStep);

    expect(child.inbox.sendMessage).toHaveBeenCalledOnce();
    expect(child.inbox.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        parts: [
          expect.objectContaining({
            type: 'data-memory-writer-event',
            data: {
              text: expect.stringMatching(
                /^(?![\s\S]*<\/?main_session_context>)[\s\S]*important work[\s\S]*$/,
              ),
            },
          }),
        ],
      }),
      expect.anything(),
    );
  });

  it('writes an assistant-only delta after the write interval while the turn continues', async () => {
    const history = [textMessage('assistant', 'assistant-work')];
    const { extension, child } = createHarness({ history });
    await extension.onStart?.();
    await extension.onStepComplete?.({
      ...completedStep,
      shouldContinue: true,
    });

    await vi.advanceTimersByTimeAsync(30_000);
    history.push(textMessage('assistant', 'more-assistant-work'));
    await extension.onStepComplete?.({
      ...completedStep,
      shouldContinue: true,
    });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(child.inbox.sendMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(child.inbox.sendMessage).toHaveBeenCalledOnce();
    expect(state(extension)).toMatchObject({
      pendingStepCount: 0,
      memoryWriteTimerActive: false,
    });
  });

  it('postpones episode finish when a new main-session step starts', async () => {
    const { extension, createChildSession } = createHarness();
    await extension.onStart?.();
    await extension.onStepComplete?.(completedStep);

    await vi.advanceTimersByTimeAsync(299_999);
    await extension.onStepStart?.();
    await vi.advanceTimersByTimeAsync(1);

    expect(createChildSession).toHaveBeenCalledTimes(2);
  });

  it('resets writer context on idle even without pending history', async () => {
    const { extension, createChildSession, child } = createHarness();
    await extension.onStart?.();
    await extension.onStepComplete?.(completedStep);

    await vi.advanceTimersByTimeAsync(300_000);

    expect(child.waitForIdle).toHaveBeenCalled();
    expect(child.close).toHaveBeenCalledOnce();
    expect(createChildSession).toHaveBeenCalledTimes(3);
  });

  it('does not resend the same delta on repeated completion hooks', async () => {
    const history = Array.from({ length: 50 }, (_, index) =>
      contextMessage([{ type: 'text', text: `ctx-${index}` }], `u${index}`),
    );
    const { extension, child } = createHarness({ history });
    await extension.onStart?.();

    await extension.onStepComplete?.(completedStep);
    await extension.onStepComplete?.(completedStep);
    await extension.onStepComplete?.(completedStep);
    await extension.onStepComplete?.(completedStep);

    expect(child.inbox.sendMessage).toHaveBeenCalledOnce();
  });

  it('flushes without debounce, waits for idle, and closes on shutdown', async () => {
    const waitForIdle = vi.fn(async (_timeoutMs: number) => true);
    const child = createChild({ waitForIdle });
    const history = [textMessage('assistant', 'pending')];
    const { extension } = createHarness({ history, child });
    await extension.onStart?.();

    await extension.onClose?.();

    expect(child.inbox.sendMessage).toHaveBeenCalledOnce();
    expect(waitForIdle).toHaveBeenCalledWith(25_000);
    expect(child.close).toHaveBeenCalledOnce();
  });

  it('streams each new delta to the retrieval child exactly once', async () => {
    const history = [contextMessage([{ type: 'text', text: 'hello' }], 'u0')];
    const { extension, retrievalChild } = createHarness({ history });
    await extension.onStart?.();
    const observations = vi.mocked(retrievalChild.inbox.sendMessage);

    extension.onStepStart?.();
    expect(observations).toHaveBeenCalledOnce();
    expect(observations.mock.calls[0]?.[0].parts[0]).toMatchObject({
      type: 'text',
      text: expect.stringMatching(/^<observation>[\s\S]*hello/u),
    });

    await extension.onStepComplete?.(completedStep);
    expect(observations).toHaveBeenCalledOnce();

    history.push(textMessage('assistant', 'a1', 'reply'));
    await extension.onStepComplete?.(completedStep);
    expect(observations).toHaveBeenCalledOnce();
    expect(state(extension).lastObservedMessageId).toBe('a1');

    history.push(contextMessage([{ type: 'text', text: 'again' }], 'u1'));
    extension.onStepStart?.();
    expect(observations).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(observations.mock.calls[1])).not.toContain('hello');
  });

  it('keeps the observation cursor independent of the writer cursor', async () => {
    const history = [contextMessage([{ type: 'text', text: 'x' }], 'u0')];
    const { extension, child } = createHarness({ history });
    await extension.onStart?.();

    extension.onStepStart?.();

    expect(state(extension)).toMatchObject({
      lastObservedMessageId: 'u0',
      lastProcessedMessageId: null,
    });
    expect(child.inbox.sendMessage).not.toHaveBeenCalled();
  });

  it('logs busy buffered work and still force-closes the writer', async () => {
    const waitForIdle = vi.fn(async (_timeoutMs: number) => false);
    const child = createChild({ waitForIdle });
    const { extension, logger } = createHarness({ child });
    await extension.onStart?.();

    await extension.onClose?.();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 25_000 }),
      expect.stringContaining('did not become idle'),
    );
    expect(child.close).toHaveBeenCalledOnce();
  });
});
