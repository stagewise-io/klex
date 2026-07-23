import { randomUUID } from 'node:crypto';

import { context } from '@opentelemetry/api';
import { APICallError, type LanguageModel } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleLogger } from '@stagewise/logger';

import { type SessionInboxBuffer, SessionInboxPriority } from '@/session/inbox';
import type { AgentTools } from '@/session/tools';
import type { ExtendedUIMessage } from '@/session/types';

import { checkAndFixHistory } from '../utils/check-and-fix-history';
import { convertToModelMessagesExtended } from '../utils/convert-to-model-messages';
import { drainInbox } from '../utils/drain-inbox';
import { executeTool } from '../utils/execute-tool';
import { repairPartialMessage } from '../utils/repair-partial-message';
import {
  runStreamedGeneration,
  type StreamedGenerationOutput,
} from '../utils/run-streamed-generation';
import { createStep, type StepDependencies } from './step';

// --- helpers ---

/** Creates an APICallError with the required fields pre-filled. */
function makeApiError(opts: {
  message: string;
  statusCode?: number;
  isRetryable?: boolean;
}): APICallError {
  return new APICallError({
    url: 'https://api.example.com/v1/chat',
    requestBodyValues: {},
    ...opts,
  });
}

// --- mocks (hoisted by vitest) ---

vi.mock('../utils/run-streamed-generation', () => ({
  runStreamedGeneration: vi.fn(),
}));
vi.mock('../utils/drain-inbox', () => ({
  drainInbox: vi.fn(),
}));
vi.mock('../utils/check-and-fix-history', () => ({
  checkAndFixHistory: vi.fn(),
}));
vi.mock('../utils/convert-to-model-messages', () => ({
  convertToModelMessagesExtended: vi.fn(),
}));
vi.mock('../utils/execute-tool', () => ({
  executeTool: vi.fn(),
}));
vi.mock('../utils/repair-partial-message', () => ({
  repairPartialMessage: vi.fn(),
}));

// --- fixtures ---

const logger: ModuleLogger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
};

function makeInbox(): SessionInboxBuffer {
  return {
    send: vi.fn(),
    getEvents: vi.fn(() => []),
    isEmpty: vi.fn(() => true),
  };
}

function makeExtensionHandler() {
  return {
    extensions: [],
    onHistoryPreProcessing: vi.fn((h: ExtendedUIMessage[]) =>
      Promise.resolve(h),
    ),
    onHistoryPostProcessing: vi.fn((h: never[]) => Promise.resolve(h)),
    getDataPartTransformers: vi.fn(() => ({})),
    onStepStart: vi.fn(),
    onStepFinish: vi.fn(),
  };
}

function makeModelProvider() {
  return {
    get: vi.fn().mockResolvedValue({} as LanguageModel),
    start: vi.fn(),
    close: vi.fn(),
  };
}

function makeDeps(overrides: Partial<StepDependencies> = {}): StepDependencies {
  return {
    logger,
    turnContext: context.active(),
    messages: [],
    inbox: makeInbox(),
    extensionHandler: makeExtensionHandler() as never,
    tools: {} as AgentTools,
    modelProvider: makeModelProvider() as never,
    getChatModelId: vi.fn(() => 'test:model' as never),
    getModelFallbackIndex: vi.fn(() => 0),
    fallbackToNextModel: vi.fn(),
    ...overrides,
  };
}

function makeToolPart(
  toolCallId: string,
  state = 'input-available',
  toolName = 'testTool',
): ExtendedUIMessage['parts'][number] {
  return {
    type: `tool-${toolName}` as never,
    toolCallId,
    state,
    input: {},
    providerExecuted: false,
  } as ExtendedUIMessage['parts'][number];
}

function makeAssistantMessage(
  parts: ExtendedUIMessage['parts'] = [],
): ExtendedUIMessage {
  return {
    id: randomUUID(),
    role: 'assistant',
    parts,
  } as ExtendedUIMessage;
}

function makeUserMessage(text = 'hello'): ExtendedUIMessage {
  return {
    id: randomUUID(),
    role: 'user',
    parts: [{ type: 'text', text }],
  } as ExtendedUIMessage;
}

/** Builds a StreamedGenerationOutput with a cast on usage (LanguageModelUsage has extra fields). */
function makeGenResult(
  message: ExtendedUIMessage,
  finishReason: StreamedGenerationOutput['finishReason'],
  error?: unknown,
): StreamedGenerationOutput {
  return {
    message,
    finishReason,
    error,
    usage: { inputTokens: 10, outputTokens: 5 } as never,
  };
}

const emptyDrainResult = {
  total: 0,
  byPriority: { low: 0, medium: 0, high: 0 },
};

function setupDefaultMocks() {
  vi.mocked(drainInbox).mockReturnValue(emptyDrainResult);
  vi.mocked(checkAndFixHistory).mockImplementation(() => {});
  vi.mocked(convertToModelMessagesExtended).mockResolvedValue([]);
  vi.mocked(executeTool).mockImplementation((async (part: {
    state: string;
    output?: unknown;
  }) => {
    Object.assign(part, { state: 'output-available', output: 'done' });
  }) as never);
  vi.mocked(repairPartialMessage).mockReturnValue(false);
  vi.mocked(runStreamedGeneration).mockResolvedValue(
    makeGenResult(
      makeAssistantMessage([{ type: 'text', text: 'response' }]),
      'stop',
    ),
  );
}

// --- tests ---

describe('Step — decision: skip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it('returns { hadGeneration: false } when no messages exist', async () => {
    const step = createStep(makeDeps({ messages: [] }));
    const result = await step.run();
    expect(result).toEqual({ hadGeneration: false, forceNextStep: false });
    expect(runStreamedGeneration).not.toHaveBeenCalled();
  });

  it('returns { hadGeneration: false } when last assistant message has no tool calls', async () => {
    const step = createStep(
      makeDeps({
        messages: [
          makeUserMessage(),
          makeAssistantMessage([{ type: 'text', text: 'hi' }]),
        ],
      }),
    );
    const result = await step.run();
    expect(result).toEqual({ hadGeneration: false, forceNextStep: false });
    expect(runStreamedGeneration).not.toHaveBeenCalled();
  });

  it('returns { hadGeneration: false } when last assistant message has unresolved tool calls', async () => {
    const step = createStep(
      makeDeps({
        messages: [
          makeUserMessage(),
          makeAssistantMessage([makeToolPart('call-1', 'input-streaming')]),
        ],
      }),
    );
    const result = await step.run();
    expect(result).toEqual({ hadGeneration: false, forceNextStep: false });
    expect(runStreamedGeneration).not.toHaveBeenCalled();
  });
});

describe('Step — decision: proceed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it('returns { hadGeneration: true } and runs generation when last message is user', async () => {
    const step = createStep(makeDeps({ messages: [makeUserMessage()] }));
    const result = await step.run();
    expect(result.hadGeneration).toBe(true);
    expect(result.forceNextStep).toBe(false);
    expect(runStreamedGeneration).toHaveBeenCalledOnce();
  });

  it('returns { hadGeneration: true } and runs generation when last assistant has all tool calls resolved', async () => {
    const step = createStep(
      makeDeps({
        messages: [
          makeUserMessage(),
          makeAssistantMessage([
            makeToolPart('call-1', 'output-available'),
            makeToolPart('call-2', 'output-error'),
          ]),
        ],
      }),
    );
    const result = await step.run();
    expect(result.hadGeneration).toBe(true);
    expect(result.forceNextStep).toBe(false);
    expect(runStreamedGeneration).toHaveBeenCalledOnce();
  });

  it('drains inbox at Medium priority', async () => {
    const step = createStep(makeDeps({ messages: [makeUserMessage()] }));
    await step.run();
    expect(drainInbox).toHaveBeenCalledOnce();
    expect(drainInbox).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      SessionInboxPriority.Medium,
      expect.anything(),
    );
  });

  it('pushes the generated message onto the messages array when finishReason is "stop"', async () => {
    const messages = [makeUserMessage()];
    const genMsg = makeAssistantMessage([{ type: 'text', text: 'reply' }]);
    vi.mocked(runStreamedGeneration).mockResolvedValue(
      makeGenResult(genMsg, 'stop'),
    );

    const step = createStep(makeDeps({ messages }));
    await step.run();

    expect(messages).toContain(genMsg);
  });

  it('pushes the generated message when finishReason is "tool-calls"', async () => {
    const messages = [makeUserMessage()];
    const genMsg = makeAssistantMessage([
      makeToolPart('call-1', 'output-available'),
    ]);
    vi.mocked(runStreamedGeneration).mockResolvedValue(
      makeGenResult(genMsg, 'tool-calls'),
    );

    const step = createStep(makeDeps({ messages }));
    await step.run();

    expect(messages).toContain(genMsg);
  });
});

describe('Step — tool dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it('dispatches tool calls that reach input-available during streaming', async () => {
    const toolPart = makeToolPart('call-1', 'input-available');
    const msg = makeAssistantMessage([toolPart]);

    vi.mocked(runStreamedGeneration).mockImplementation(async (params) => {
      params.onUpdate(msg);
      return makeGenResult(msg, 'tool-calls');
    });

    const step = createStep(makeDeps({ messages: [makeUserMessage()] }));
    await step.run();

    expect(executeTool).toHaveBeenCalledOnce();
    expect(executeTool).toHaveBeenCalledWith(
      toolPart,
      expect.anything(),
      expect.objectContaining({ toolCallId: 'call-1' }),
    );
  });

  it('executes each tool call at most once even if onUpdate fires multiple times', async () => {
    const part = makeToolPart('call-1', 'input-available');
    const msg1 = makeAssistantMessage([part]);
    const msg2 = makeAssistantMessage([part]);

    vi.mocked(runStreamedGeneration).mockImplementation(async (params) => {
      params.onUpdate(msg1);
      params.onUpdate(msg2);
      return makeGenResult(msg2, 'tool-calls');
    });

    const step = createStep(makeDeps({ messages: [makeUserMessage()] }));
    await step.run();

    expect(executeTool).toHaveBeenCalledOnce();
  });

  it('does not dispatch tool calls still in input-streaming state', async () => {
    const part = makeToolPart('call-1', 'input-streaming');
    const msg = makeAssistantMessage([part]);

    vi.mocked(runStreamedGeneration).mockImplementation(async (params) => {
      params.onUpdate(msg);
      return makeGenResult(msg, 'tool-calls');
    });

    const step = createStep(makeDeps({ messages: [makeUserMessage()] }));
    await step.run();

    expect(executeTool).not.toHaveBeenCalled();
  });

  it('does not dispatch provider-executed tool calls', async () => {
    const part = makeToolPart('call-1', 'input-available');
    (part as Record<string, unknown>).providerExecuted = true;
    const msg = makeAssistantMessage([part]);

    vi.mocked(runStreamedGeneration).mockImplementation(async (params) => {
      params.onUpdate(msg);
      return makeGenResult(msg, 'tool-calls');
    });

    const step = createStep(makeDeps({ messages: [makeUserMessage()] }));
    await step.run();

    expect(executeTool).not.toHaveBeenCalled();
  });
});

describe('Step — post-generation tool sweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it('dispatches tool calls found only in the final message (not during streaming)', async () => {
    const toolPart = makeToolPart('call-sweep', 'input-available');
    const msg = makeAssistantMessage([toolPart]);

    // onUpdate is NOT called — the tool part only appears in the returned message
    vi.mocked(runStreamedGeneration).mockResolvedValue(
      makeGenResult(msg, 'tool-calls'),
    );

    const step = createStep(makeDeps({ messages: [makeUserMessage()] }));
    await step.run();

    expect(executeTool).toHaveBeenCalledOnce();
    expect(executeTool).toHaveBeenCalledWith(
      toolPart,
      expect.anything(),
      expect.objectContaining({ toolCallId: 'call-sweep' }),
    );
  });

  it('does not double-dispatch tools that were already dispatched during streaming', async () => {
    const part = makeToolPart('call-1', 'input-available');
    const msg = makeAssistantMessage([part]);

    vi.mocked(runStreamedGeneration).mockImplementation(async (params) => {
      params.onUpdate(msg);
      return makeGenResult(msg, 'tool-calls');
    });

    const step = createStep(makeDeps({ messages: [makeUserMessage()] }));
    await step.run();

    // Once from streaming, zero additional from sweep
    expect(executeTool).toHaveBeenCalledOnce();
  });
});

describe('Step — tool settlement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it('awaits all in-flight tool executions before returning', async () => {
    const toolPart = makeToolPart('call-1', 'input-available');
    const msg = makeAssistantMessage([toolPart]);

    let toolResolved = false;
    vi.mocked(executeTool).mockImplementation((async (part: {
      state: string;
      output?: unknown;
    }) => {
      await new Promise((r) => setTimeout(r, 20));
      toolResolved = true;
      Object.assign(part, { state: 'output-available', output: 'done' });
    }) as never);

    vi.mocked(runStreamedGeneration).mockImplementation(async (params) => {
      params.onUpdate(msg);
      return makeGenResult(msg, 'tool-calls');
    });

    const step = createStep(makeDeps({ messages: [makeUserMessage()] }));
    await step.run();

    expect(toolResolved).toBe(true);
  });
});

describe('Step — abort', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it('abortGeneration aborts the signal passed to runStreamedGeneration', async () => {
    let capturedSignal: AbortSignal | undefined;
    vi.mocked(runStreamedGeneration).mockImplementation(async (params) => {
      capturedSignal = params.abortSignal;
      await new Promise((r) => setTimeout(r, 50));
      return makeGenResult(makeAssistantMessage(), 'stop');
    });

    const step = createStep(makeDeps({ messages: [makeUserMessage()] }));
    const runPromise = step.run();

    await new Promise((r) => setTimeout(r, 10));
    step.abortGeneration();
    await runPromise;

    expect(capturedSignal?.aborted).toBe(true);
  });

  it('does not abort the tool abort signal when generation is aborted', async () => {
    const toolPart = makeToolPart('call-1', 'input-available');
    const msg = makeAssistantMessage([toolPart]);

    let capturedToolSignal: AbortSignal | undefined;
    vi.mocked(executeTool).mockImplementation((async (
      part: { state: string; output?: unknown },
      _tools: unknown,
      opts: { abortSignal: AbortSignal },
    ) => {
      capturedToolSignal = opts.abortSignal;
      await new Promise((r) => setTimeout(r, 30));
      Object.assign(part, { state: 'output-available', output: 'done' });
    }) as never);

    vi.mocked(runStreamedGeneration).mockImplementation(async (params) => {
      params.onUpdate(msg);
      await new Promise((r) => setTimeout(r, 50));
      return makeGenResult(msg, 'tool-calls');
    });

    const step = createStep(makeDeps({ messages: [makeUserMessage()] }));
    const runPromise = step.run();

    await new Promise((r) => setTimeout(r, 10));
    step.abortGeneration();
    await runPromise;

    expect(capturedToolSignal?.aborted).toBe(false);
  });
});

describe('Step — non-good finish reasons', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it('returns forceNextStep=true when finishReason is "length"', async () => {
    const genMsg = makeAssistantMessage([{ type: 'text', text: 'partial' }]);
    vi.mocked(runStreamedGeneration).mockResolvedValue(
      makeGenResult(genMsg, 'length'),
    );
    vi.mocked(repairPartialMessage).mockReturnValue(true);

    const messages = [makeUserMessage()];
    const step = createStep(makeDeps({ messages }));
    const result = await step.run();

    expect(result.hadGeneration).toBe(true);
    expect(result.forceNextStep).toBe(true);
    expect(messages).toContain(genMsg);
  });

  it('returns forceNextStep=true when finishReason is "content-filter"', async () => {
    const genMsg = makeAssistantMessage([{ type: 'text', text: '' }]);
    vi.mocked(runStreamedGeneration).mockResolvedValue(
      makeGenResult(genMsg, 'content-filter'),
    );

    const step = createStep(makeDeps({ messages: [makeUserMessage()] }));
    const result = await step.run();

    expect(result.forceNextStep).toBe(true);
  });

  it('returns forceNextStep=true when finishReason is "other"', async () => {
    const genMsg = makeAssistantMessage([{ type: 'text', text: '' }]);
    vi.mocked(runStreamedGeneration).mockResolvedValue(
      makeGenResult(genMsg, 'other'),
    );

    const step = createStep(makeDeps({ messages: [makeUserMessage()] }));
    const result = await step.run();

    expect(result.forceNextStep).toBe(true);
  });

  it('does not push the message when salvage fails', async () => {
    const genMsg = makeAssistantMessage([{ type: 'text', text: '' }]);
    vi.mocked(runStreamedGeneration).mockResolvedValue(
      makeGenResult(genMsg, 'length'),
    );
    vi.mocked(repairPartialMessage).mockReturnValue(false);

    const messages = [makeUserMessage()];
    const step = createStep(makeDeps({ messages }));
    await step.run();

    expect(messages).not.toContain(genMsg);
    expect(messages).toHaveLength(1);
  });
});

describe('Step — error finish reason with model fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it('triggers fallbackToNextModel when error is a 5xx API error', async () => {
    const fallbackFn = vi.fn();
    const apiError = makeApiError({
      message: 'Internal Server Error',
      statusCode: 500,
    });
    vi.mocked(runStreamedGeneration).mockResolvedValue(
      makeGenResult(makeAssistantMessage(), 'error', apiError),
    );

    const step = createStep(
      makeDeps({
        messages: [makeUserMessage()],
        fallbackToNextModel: fallbackFn,
      }),
    );
    const result = await step.run();

    expect(fallbackFn).toHaveBeenCalledOnce();
    expect(result.forceNextStep).toBe(true);
  });

  it('triggers fallbackToNextModel when error is a 429 API error', async () => {
    const fallbackFn = vi.fn();
    const apiError = makeApiError({
      message: 'Too Many Requests',
      statusCode: 429,
    });
    vi.mocked(runStreamedGeneration).mockResolvedValue(
      makeGenResult(makeAssistantMessage(), 'error', apiError),
    );

    const step = createStep(
      makeDeps({
        messages: [makeUserMessage()],
        fallbackToNextModel: fallbackFn,
      }),
    );
    await step.run();

    expect(fallbackFn).toHaveBeenCalledOnce();
  });

  it('does NOT trigger fallbackToNextModel when error is a 400 API error', async () => {
    const fallbackFn = vi.fn();
    const apiError = makeApiError({
      message: 'Bad Request',
      statusCode: 400,
    });
    vi.mocked(runStreamedGeneration).mockResolvedValue(
      makeGenResult(makeAssistantMessage(), 'error', apiError),
    );

    const step = createStep(
      makeDeps({
        messages: [makeUserMessage()],
        fallbackToNextModel: fallbackFn,
      }),
    );
    const result = await step.run();

    expect(fallbackFn).not.toHaveBeenCalled();
    expect(result.forceNextStep).toBe(true);
  });

  it('triggers fallbackToNextModel when error is null (no details)', async () => {
    const fallbackFn = vi.fn();
    vi.mocked(runStreamedGeneration).mockResolvedValue(
      makeGenResult(makeAssistantMessage(), 'error', null),
    );

    const step = createStep(
      makeDeps({
        messages: [makeUserMessage()],
        fallbackToNextModel: fallbackFn,
      }),
    );
    await step.run();

    expect(fallbackFn).toHaveBeenCalledOnce();
  });

  it('always sets forceNextStep=true on error finish reason, regardless of fallback', async () => {
    const fallbackFn = vi.fn();
    const apiError = makeApiError({
      message: 'Bad Request',
      statusCode: 400,
    });
    vi.mocked(runStreamedGeneration).mockResolvedValue(
      makeGenResult(makeAssistantMessage(), 'error', apiError),
    );

    const step = createStep(
      makeDeps({
        messages: [makeUserMessage()],
        fallbackToNextModel: fallbackFn,
      }),
    );
    const result = await step.run();

    expect(result.forceNextStep).toBe(true);
  });
});

describe('Step — generation exception handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it('catches thrown 5xx API error, triggers fallback, and forces next step', async () => {
    const fallbackFn = vi.fn();
    const apiError = makeApiError({
      message: 'Service Unavailable',
      statusCode: 503,
    });
    vi.mocked(runStreamedGeneration).mockRejectedValue(apiError);

    const step = createStep(
      makeDeps({
        messages: [makeUserMessage()],
        fallbackToNextModel: fallbackFn,
      }),
    );
    const result = await step.run();

    expect(fallbackFn).toHaveBeenCalledOnce();
    expect(result.hadGeneration).toBe(true);
    expect(result.forceNextStep).toBe(true);
  });

  it('catches thrown network error and triggers fallback', async () => {
    const fallbackFn = vi.fn();
    vi.mocked(runStreamedGeneration).mockRejectedValue(
      new Error('Request timeout after 30000ms'),
    );

    const step = createStep(
      makeDeps({
        messages: [makeUserMessage()],
        fallbackToNextModel: fallbackFn,
      }),
    );
    await step.run();

    expect(fallbackFn).toHaveBeenCalledOnce();
  });

  it('catches thrown 400 API error without triggering fallback', async () => {
    const fallbackFn = vi.fn();
    const apiError = makeApiError({
      message: 'Bad Request',
      statusCode: 400,
    });
    vi.mocked(runStreamedGeneration).mockRejectedValue(apiError);

    const step = createStep(
      makeDeps({
        messages: [makeUserMessage()],
        fallbackToNextModel: fallbackFn,
      }),
    );
    const result = await step.run();

    expect(fallbackFn).not.toHaveBeenCalled();
    expect(result.forceNextStep).toBe(true);
  });

  it('salvages partial message from streaming when generation throws', async () => {
    const partialMsg = makeAssistantMessage([
      { type: 'text', text: 'partial response' },
    ]);
    vi.mocked(runStreamedGeneration).mockImplementation(async (params) => {
      params.onUpdate(partialMsg);
      throw makeApiError({ message: 'fail', statusCode: 500 });
    });
    vi.mocked(repairPartialMessage).mockReturnValue(true);

    const messages = [makeUserMessage()];
    const step = createStep(makeDeps({ messages }));
    await step.run();

    expect(repairPartialMessage).toHaveBeenCalledWith(partialMsg);
    expect(messages).toContain(partialMsg);
  });

  it('does not push partial message when salvage fails on exception', async () => {
    const partialMsg = makeAssistantMessage([{ type: 'text', text: '' }]);
    vi.mocked(runStreamedGeneration).mockImplementation(async (params) => {
      params.onUpdate(partialMsg);
      throw makeApiError({ message: 'fail', statusCode: 500 });
    });
    vi.mocked(repairPartialMessage).mockReturnValue(false);

    const messages = [makeUserMessage()];
    const step = createStep(makeDeps({ messages }));
    await step.run();

    expect(messages).toHaveLength(1);
  });
});
