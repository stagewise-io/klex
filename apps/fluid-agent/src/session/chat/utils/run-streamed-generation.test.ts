import {
  type LanguageModel,
  readUIMessageStream,
  streamText,
  toUIMessageStream,
} from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExtendedUIMessage } from '../message-types';
import { testLogger as logger } from '../test-helpers';
import type { AgentTools } from '../tools';
import { runStreamedGeneration } from './run-streamed-generation';

// --- mocks (hoisted by vitest) ---

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    streamText: vi.fn(),
    toUIMessageStream: vi.fn(),
    readUIMessageStream: vi.fn(),
  };
});

vi.mock('./system-prompt.md', () => ({ default: 'mock system prompt' }));
vi.mock('./tools-without-execute', () => ({
  toolsWithoutExecute: vi.fn((tools: unknown) => tools),
}));

// --- fixtures ---

const model = {} as LanguageModel;
const tools = {} as AgentTools;
const abortSignal = new AbortController().signal;
const getChatModelId = vi.fn(() => 'test:model' as never);

async function* fromArray<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) {
    yield item;
  }
}

function setupSuccessResult(opts: {
  messages?: ExtendedUIMessage[];
  finishReason?: string;
  usage?: { inputTokens: number; outputTokens: number };
}) {
  const messages = opts.messages ?? [];
  const finishReason = opts.finishReason ?? 'stop';
  const usage = opts.usage ?? { inputTokens: 10, outputTokens: 5 };
  const mockStream = Symbol('mock-stream');

  vi.mocked(streamText).mockReturnValue({
    stream: mockStream,
    finishReason: Promise.resolve(finishReason as never),
    rawFinishReason: Promise.resolve(undefined),
    usage: Promise.resolve(usage as never),
  } as never);
  vi.mocked(toUIMessageStream).mockReturnValue(mockStream as never);
  vi.mocked(readUIMessageStream).mockImplementation((({
    message,
  }: {
    message: ExtendedUIMessage;
  }) => fromArray(messages.length > 0 ? messages : [message])) as never);
}

// --- tests ---

describe('runStreamedGeneration — success', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the final message, finishReason, and usage', async () => {
    const msg = {
      id: 'msg-1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'hello' }],
    } as ExtendedUIMessage;

    setupSuccessResult({
      messages: [msg],
      finishReason: 'stop',
      usage: { inputTokens: 15, outputTokens: 8 },
    });

    const result = await runStreamedGeneration({
      model,
      modelMessages: [],
      tools,
      onUpdate: vi.fn(),
      abortSignal,
      logger,
      getChatModelId,
      sessionId: 'test-session',
      compacted: false,
    });

    expect(result.message).toBe(msg);
    expect(result.finishReason).toBe('stop');
    expect(result.usage.inputTokens).toBe(15);
    expect(result.usage.outputTokens).toBe(8);
  });

  it('calls onUpdate for each UI message chunk from the stream', async () => {
    const msg1 = {
      id: 'msg-1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'hel' }],
    } as ExtendedUIMessage;
    const msg2 = {
      id: 'msg-1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'hello' }],
    } as ExtendedUIMessage;

    setupSuccessResult({ messages: [msg1, msg2] });

    const onUpdate = vi.fn();
    await runStreamedGeneration({
      model,
      modelMessages: [],
      tools,
      onUpdate,
      abortSignal,
      logger,
      getChatModelId,
      sessionId: 'test-session',
      compacted: false,
    });

    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(onUpdate).toHaveBeenNthCalledWith(1, msg1);
    expect(onUpdate).toHaveBeenNthCalledWith(2, msg2);
  });

  it('passes model, tools, messages, and abortSignal to streamText', async () => {
    setupSuccessResult({
      messages: [
        {
          id: 'msg-1',
          role: 'assistant',
          parts: [{ type: 'text', text: 'hello' }],
        } as ExtendedUIMessage,
      ],
    });

    const modelMessages = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ] as never;

    await runStreamedGeneration({
      model,
      modelMessages,
      tools,
      onUpdate: vi.fn(),
      abortSignal,
      logger,
      getChatModelId,
      sessionId: 'test-session',
      compacted: false,
    });

    expect(streamText).toHaveBeenCalledOnce();
    const calls = vi.mocked(streamText).mock.calls;
    const call = calls[calls.length - 1] as unknown as [
      Record<string, unknown>,
    ];
    const arg = call[0];
    expect(arg.model).toBe(model);
    expect(arg.messages).toBe(modelMessages);
    expect(arg.abortSignal).toBe(abortSignal);
  });

  it('passes sessionId and compacted via runtimeContext to streamText', async () => {
    setupSuccessResult({
      messages: [
        {
          id: 'msg-1',
          role: 'assistant',
          parts: [{ type: 'text', text: 'hello' }],
        } as ExtendedUIMessage,
      ],
    });

    await runStreamedGeneration({
      model,
      modelMessages: [],
      tools,
      onUpdate: vi.fn(),
      abortSignal,
      logger,
      getChatModelId,
      sessionId: 'session-uuid-123',
      compacted: true,
    });

    const calls = vi.mocked(streamText).mock.calls;
    const call = calls[calls.length - 1] as unknown as [
      Record<string, unknown>,
    ];
    const arg = call[0];
    expect(arg.runtimeContext).toEqual({
      'conversation.id': 'session-uuid-123',
      'conversation.compacted': true,
    });
  });

  it('sets error to rawFinishReason when finishReason is "error"', async () => {
    const mockStream = Symbol('mock-stream');
    vi.mocked(streamText).mockReturnValue({
      stream: mockStream,
      finishReason: Promise.resolve('error' as never),
      rawFinishReason: Promise.resolve('rate-limited' as never),
      usage: Promise.resolve({ inputTokens: 1, outputTokens: 0 } as never),
    } as never);
    vi.mocked(toUIMessageStream).mockReturnValue(mockStream as never);
    vi.mocked(readUIMessageStream).mockImplementation((({
      message,
    }: {
      message: ExtendedUIMessage;
    }) =>
      fromArray([
        {
          ...message,
          parts: [{ type: 'text' as const, text: 'partial' }],
        },
      ])) as never);

    const result = await runStreamedGeneration({
      model,
      modelMessages: [],
      tools,
      onUpdate: vi.fn(),
      abortSignal,
      logger,
      getChatModelId,
      sessionId: 'test-session',
      compacted: false,
    });

    expect(result.finishReason).toBe('error');
    expect(result.error).toBe('rate-limited');
  });
});

describe('runStreamedGeneration — empty response', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws EmptyResponseBodyError when message has no parts', async () => {
    const mockStream = Symbol('mock-stream');
    vi.mocked(streamText).mockReturnValue({
      stream: mockStream,
      finishReason: Promise.resolve('stop' as never),
      rawFinishReason: Promise.resolve(undefined),
      usage: Promise.resolve({ inputTokens: 0, outputTokens: 0 } as never),
    } as never);
    vi.mocked(toUIMessageStream).mockReturnValue(mockStream as never);
    // readUIMessageStream returns the initial empty message (no parts)
    vi.mocked(readUIMessageStream).mockImplementation((({
      message,
    }: {
      message: ExtendedUIMessage;
    }) => fromArray([message])) as never);

    await expect(
      runStreamedGeneration({
        model,
        modelMessages: [],
        tools,
        onUpdate: vi.fn(),
        abortSignal,
        logger,
        getChatModelId,
        sessionId: 'test-session',
        compacted: false,
      }),
    ).rejects.toThrow('No content received during generation.');
  });
});

describe('runStreamedGeneration — error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('re-throws errors thrown by streamText', async () => {
    vi.mocked(streamText).mockImplementation(() => {
      throw new Error('Model unavailable');
    });

    await expect(
      runStreamedGeneration({
        model,
        modelMessages: [],
        tools,
        onUpdate: vi.fn(),
        abortSignal,
        logger,
        getChatModelId,
        sessionId: 'test-session',
        compacted: false,
      }),
    ).rejects.toThrow('Model unavailable');
  });

  it('re-throws errors from the stream processing loop', async () => {
    vi.mocked(streamText).mockReturnValue({
      stream: Symbol('stream'),
      finishReason: Promise.resolve('stop' as never),
      rawFinishReason: Promise.resolve(undefined),
      usage: Promise.resolve({ inputTokens: 0, outputTokens: 0 } as never),
    } as never);
    vi.mocked(toUIMessageStream).mockReturnValue(Symbol('stream') as never);
    vi.mocked(readUIMessageStream).mockImplementation(() => {
      throw new Error('Stream processing failed');
    });

    await expect(
      runStreamedGeneration({
        model,
        modelMessages: [],
        tools,
        onUpdate: vi.fn(),
        abortSignal,
        logger,
        getChatModelId,
        sessionId: 'test-session',
        compacted: false,
      }),
    ).rejects.toThrow('Stream processing failed');
  });
});
