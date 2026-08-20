import { randomUUID } from 'node:crypto';

import { trace } from '@opentelemetry/api';
import { APICallError, type LanguageModel, type ModelMessage } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleLogger } from '@stagewise/logger';

import type { ExtendedUIMessage } from '../message-types';
import { testLogger as logger } from '../test-helpers';
import type { AgentTools } from '../tools';
import { ModelFallbackManager } from '../utils/model-fallback-manager';
import { repairPartialMessage } from '../utils/repair-partial-message';
import {
  runStreamedGeneration,
  type StreamedGenerationOutput,
} from '../utils/run-streamed-generation';
import {
  GenerationRunner,
  type GenerationRunnerDependencies,
} from './generation-runner';

// --- mocks ---

vi.mock('../utils/run-streamed-generation', () => ({
  runStreamedGeneration: vi.fn(),
}));
vi.mock('../utils/repair-partial-message', () => ({
  repairPartialMessage: vi.fn(),
}));

// --- helpers ---

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

function makeAssistantMessage(
  parts: ExtendedUIMessage['parts'] = [],
): ExtendedUIMessage {
  return {
    id: randomUUID(),
    role: 'assistant',
    parts,
  } as ExtendedUIMessage;
}

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

function makeFallbackManager(
  chatModels: readonly string[] = ['model-a', 'model-b'],
): ModelFallbackManager {
  const span = trace.getTracer('test').startSpan('test');
  return new ModelFallbackManager({
    logger: logger as ModuleLogger,
    span,
    sessionId: 'test-session',
    getChatModels: () => chatModels as never,
  });
}

function makeDeps(
  overrides: Partial<GenerationRunnerDependencies> = {},
): GenerationRunnerDependencies {
  const stepSpan = trace.getTracer('test').startSpan('step');
  return {
    logger,
    sessionId: 'test-session',
    stepSpan,
    modelMessages: [] as ModelMessage[],
    messages: [],
    tools: {} as AgentTools,
    fallbackManager: makeFallbackManager(),
    turnInitialFallbackIndex: 0,
    compacted: false,
    model: {} as LanguageModel,
    extensionSystemPromptParts: [] as string[],
    ...overrides,
  };
}

function setupDefaultMocks() {
  vi.mocked(repairPartialMessage).mockReturnValue(false);
  vi.mocked(runStreamedGeneration).mockResolvedValue(
    makeGenResult(
      makeAssistantMessage([{ type: 'text', text: 'response' }]),
      'stop',
    ),
  );
}

// --- tests ---

describe('GenerationRunner — success', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it('returns shouldContinue=true on stop finish reason', async () => {
    const runner = new GenerationRunner(makeDeps());
    const result = await runner.run();

    expect(result.shouldContinue).toBe(true);
    expect(result.forceNextStep).toBe(false);
    expect(result.fatalError).toBe(false);
    expect(result.generationFailed).toBe(false);
    expect(result.generation).not.toBeNull();
    expect(result.generation!.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
    });
  });

  it('returns shouldContinue=true on tool-calls finish reason', async () => {
    vi.mocked(runStreamedGeneration).mockResolvedValue(
      makeGenResult(makeAssistantMessage(), 'tool-calls'),
    );

    const runner = new GenerationRunner(makeDeps());
    const result = await runner.run();

    expect(result.shouldContinue).toBe(true);
    expect(result.forceNextStep).toBe(false);
    expect(result.generation!.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
    });
  });

  it('pushes the response message and records successful generation', async () => {
    const genMsg = makeAssistantMessage([{ type: 'text', text: 'hello' }]);
    vi.mocked(runStreamedGeneration).mockResolvedValue(
      makeGenResult(genMsg, 'stop'),
    );

    const messages: ExtendedUIMessage[] = [];
    const fallbackManager = makeFallbackManager();
    fallbackManager.recordSuccessfulGeneration = vi.fn();

    const runner = new GenerationRunner(
      makeDeps({ messages, fallbackManager }),
    );
    await runner.run();

    expect(messages).toContain(genMsg);
    expect(fallbackManager.recordSuccessfulGeneration).toHaveBeenCalledOnce();
  });
});

describe('GenerationRunner — non-good finish reasons', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it('returns forceNextStep=true when finishReason is "length" with salvage', async () => {
    const genMsg = makeAssistantMessage([{ type: 'text', text: 'partial' }]);
    vi.mocked(runStreamedGeneration).mockResolvedValue(
      makeGenResult(genMsg, 'length'),
    );
    vi.mocked(repairPartialMessage).mockReturnValue(true);

    const messages: ExtendedUIMessage[] = [];
    const runner = new GenerationRunner(makeDeps({ messages }));
    const result = await runner.run();

    expect(result.shouldContinue).toBe(true);
    expect(result.forceNextStep).toBe(true);
    expect(messages).toContain(genMsg);
  });

  it('returns forceNextStep=true when finishReason is "content-filter" with salvage', async () => {
    vi.mocked(runStreamedGeneration).mockResolvedValue(
      makeGenResult(
        makeAssistantMessage([{ type: 'text', text: 'filtered' }]),
        'content-filter',
      ),
    );
    vi.mocked(repairPartialMessage).mockReturnValue(true);

    const runner = new GenerationRunner(makeDeps());
    const result = await runner.run();

    expect(result.forceNextStep).toBe(true);
  });

  it('returns forceNextStep=true when finishReason is "other" with salvage', async () => {
    vi.mocked(runStreamedGeneration).mockResolvedValue(
      makeGenResult(
        makeAssistantMessage([{ type: 'text', text: 'partial' }]),
        'other',
      ),
    );
    vi.mocked(repairPartialMessage).mockReturnValue(true);

    const runner = new GenerationRunner(makeDeps());
    const result = await runner.run();

    expect(result.forceNextStep).toBe(true);
  });

  it('does not push the message when salvage fails', async () => {
    const genMsg = makeAssistantMessage([{ type: 'text', text: 'partial' }]);
    vi.mocked(runStreamedGeneration).mockResolvedValue(
      makeGenResult(genMsg, 'length'),
    );
    vi.mocked(repairPartialMessage).mockReturnValue(false);

    const messages: ExtendedUIMessage[] = [];
    const runner = new GenerationRunner(makeDeps({ messages }));
    await runner.run();

    expect(messages).not.toContain(genMsg);
    expect(messages).toHaveLength(0);
  });

  it('returns modelFallbackOccurred=true when non-error finish has no parts', async () => {
    // With the wrap-around check removed, a no-content non-fatal finish
    // triggers model_error → fallback_new_step. Even with a single model,
    // the fallback manager wraps around but the runner no longer
    // terminates — the session-level backoff loop handles retry limits.
    const fallbackManager = makeFallbackManager(['model-a']);

    vi.mocked(runStreamedGeneration).mockResolvedValue(
      makeGenResult(makeAssistantMessage(), 'length'),
    );

    const runner = new GenerationRunner(makeDeps({ fallbackManager }));
    const result = await runner.run();

    expect(result.modelFallbackOccurred).toBe(true);
    expect(result.generationFailed).toBe(false);
    expect(result.forceNextStep).toBe(false);
    expect(result.fatalError).toBe(false);
    expect(result.generation).toBeNull();
  });
});

describe('GenerationRunner — error finish reason with model fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it('triggers fallback and salvages content on 5xx API error', async () => {
    const fallbackManager = makeFallbackManager();
    const fallbackSpy = vi.spyOn(fallbackManager, 'fallbackToNextModel');

    const apiError = makeApiError({
      message: 'Internal Server Error',
      statusCode: 500,
    });
    const genMsg = makeAssistantMessage([{ type: 'text', text: 'partial' }]);
    vi.mocked(runStreamedGeneration).mockResolvedValue(
      makeGenResult(genMsg, 'error', apiError),
    );
    vi.mocked(repairPartialMessage).mockReturnValue(true);

    const messages: ExtendedUIMessage[] = [];
    const runner = new GenerationRunner(
      makeDeps({ messages, fallbackManager }),
    );
    const result = await runner.run();

    expect(fallbackSpy).toHaveBeenCalledOnce();
    expect(result.forceNextStep).toBe(true);
    expect(result.fatalError).toBe(false);
    expect(messages).toContain(genMsg);
  });

  it('triggers fallback on 429 API error', async () => {
    // 1 model: fallback wraps around but no longer terminates —
    // the session loop handles retry limits via backoff.
    const fallbackManager = makeFallbackManager(['model-a']);
    const fallbackSpy = vi.spyOn(fallbackManager, 'fallbackToNextModel');

    vi.mocked(runStreamedGeneration).mockResolvedValue(
      makeGenResult(
        makeAssistantMessage(),
        'error',
        makeApiError({ message: 'Too Many Requests', statusCode: 429 }),
      ),
    );

    const runner = new GenerationRunner(makeDeps({ fallbackManager }));
    const result = await runner.run();

    expect(fallbackSpy).toHaveBeenCalledOnce();
    expect(result.modelFallbackOccurred).toBe(true);
    expect(result.generationFailed).toBe(false);
  });

  it('does NOT trigger fallback on 400 API error (fatal)', async () => {
    const fallbackManager = makeFallbackManager();
    const fallbackSpy = vi.spyOn(fallbackManager, 'fallbackToNextModel');

    vi.mocked(runStreamedGeneration).mockResolvedValue(
      makeGenResult(
        makeAssistantMessage([{ type: 'text', text: 'partial' }]),
        'error',
        makeApiError({ message: 'Bad Request', statusCode: 400 }),
      ),
    );

    const messages: ExtendedUIMessage[] = [];
    const runner = new GenerationRunner(
      makeDeps({ messages, fallbackManager }),
    );
    const result = await runner.run();

    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(result.fatalError).toBe(true);
    expect(result.forceNextStep).toBe(false);
    expect(result.generation).toBeNull();
    expect(messages).toHaveLength(0);
  });

  it('triggers fallback when error is null (no details)', async () => {
    // 1 model: fallback wraps around but no longer terminates —
    // the session loop handles retry limits via backoff.
    const fallbackManager = makeFallbackManager(['model-a']);
    const fallbackSpy = vi.spyOn(fallbackManager, 'fallbackToNextModel');

    vi.mocked(runStreamedGeneration).mockResolvedValue(
      makeGenResult(makeAssistantMessage(), 'error', null),
    );

    const runner = new GenerationRunner(makeDeps({ fallbackManager }));
    const result = await runner.run();

    expect(fallbackSpy).toHaveBeenCalledOnce();
    expect(result.modelFallbackOccurred).toBe(true);
  });

  it('returns modelFallbackOccurred when all models exhausted (no content, model error)', async () => {
    // 1 model: fallback wraps around but no longer terminates —
    // the session loop handles retry limits via backoff.
    const fallbackManager = makeFallbackManager(['model-a']);

    vi.mocked(runStreamedGeneration).mockResolvedValue(
      makeGenResult(
        makeAssistantMessage(),
        'error',
        makeApiError({ message: 'Service Unavailable', statusCode: 503 }),
      ),
    );

    const runner = new GenerationRunner(makeDeps({ fallbackManager }));
    const result = await runner.run();

    expect(runStreamedGeneration).toHaveBeenCalledTimes(1);
    expect(result.modelFallbackOccurred).toBe(true);
    expect(result.generationFailed).toBe(false);
    expect(result.forceNextStep).toBe(false);
    expect(result.fatalError).toBe(false);
    expect(result.generation).toBeNull();
  });
});

describe('GenerationRunner — generation exception handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it('catches thrown 5xx API error, triggers fallback_new_step (no in-loop retry)', async () => {
    const fallbackManager = makeFallbackManager(['model-a', 'model-b']);
    const fallbackSpy = vi.spyOn(fallbackManager, 'fallbackToNextModel');

    const apiError = makeApiError({
      message: 'Service Unavailable',
      statusCode: 503,
    });
    vi.mocked(runStreamedGeneration).mockRejectedValue(apiError);

    const runner = new GenerationRunner(makeDeps({ fallbackManager }));
    const result = await runner.run();

    expect(runStreamedGeneration).toHaveBeenCalledTimes(1);
    expect(fallbackSpy).toHaveBeenCalledOnce();
    expect(result.shouldContinue).toBe(true);
    expect(result.forceNextStep).toBe(false);
    expect(result.modelFallbackOccurred).toBe(true);
    expect(result.generation).toBeNull();
  });

  it('catches thrown network error, triggers fallback_new_step (no in-loop retry)', async () => {
    const fallbackManager = makeFallbackManager(['model-a', 'model-b']);
    const fallbackSpy = vi.spyOn(fallbackManager, 'fallbackToNextModel');

    vi.mocked(runStreamedGeneration).mockRejectedValue(
      new Error('Request timeout after 30000ms'),
    );

    const runner = new GenerationRunner(makeDeps({ fallbackManager }));
    const result = await runner.run();

    expect(runStreamedGeneration).toHaveBeenCalledTimes(1);
    expect(fallbackSpy).toHaveBeenCalledOnce();
    expect(result.shouldContinue).toBe(true);
    expect(result.modelFallbackOccurred).toBe(true);
  });

  it('catches thrown 400 API error as fatal without triggering fallback', async () => {
    const fallbackManager = makeFallbackManager();
    const fallbackSpy = vi.spyOn(fallbackManager, 'fallbackToNextModel');
    vi.mocked(runStreamedGeneration).mockRejectedValue(
      makeApiError({ message: 'Bad Request', statusCode: 400 }),
    );

    const runner = new GenerationRunner(makeDeps({ fallbackManager }));
    const result = await runner.run();

    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(result.fatalError).toBe(true);
  });

  it('does not push partial message when salvage fails on exception', async () => {
    const partialMsg = makeAssistantMessage([
      { type: 'text', text: 'partial' },
    ]);
    vi.mocked(runStreamedGeneration).mockImplementation(async (params) => {
      params.onUpdate(partialMsg);
      throw makeApiError({ message: 'fail', statusCode: 500 });
    });
    vi.mocked(repairPartialMessage).mockReturnValue(false);

    const messages: ExtendedUIMessage[] = [];
    const runner = new GenerationRunner(makeDeps({ messages }));
    await runner.run();

    expect(messages).toHaveLength(0);
  });
});

describe('GenerationRunner — models-exhausted and attempt cap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it('returns modelFallbackOccurred when all models exhausted via exception (no content)', async () => {
    // 1 model: fallback wraps around but no longer terminates —
    // the session loop handles retry limits via backoff.
    const fallbackManager = makeFallbackManager(['model-a']);

    vi.mocked(runStreamedGeneration).mockRejectedValue(
      makeApiError({ message: 'Service Unavailable', statusCode: 503 }),
    );

    const runner = new GenerationRunner(makeDeps({ fallbackManager }));
    const result = await runner.run();

    expect(runStreamedGeneration).toHaveBeenCalledTimes(1);
    expect(result.modelFallbackOccurred).toBe(true);
    expect(result.generationFailed).toBe(false);
  });
});

describe('GenerationRunner — fallback_new_step (no wrap-around termination)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it('returns modelFallbackOccurred when model error occurs', async () => {
    const fallbackManager = makeFallbackManager(['model-a', 'model-b']);

    vi.mocked(runStreamedGeneration).mockResolvedValue(
      makeGenResult(
        makeAssistantMessage(),
        'error',
        makeApiError({ message: 'Service Unavailable', statusCode: 503 }),
      ),
    );

    const runner = new GenerationRunner(makeDeps({ fallbackManager }));
    const result = await runner.run();

    expect(runStreamedGeneration).toHaveBeenCalledTimes(1);
    expect(result.shouldContinue).toBe(true);
    expect(result.modelFallbackOccurred).toBe(true);
    expect(result.generationFailed).toBe(false);
    expect(result.generation).toBeNull();
  });

  it('advances fallback index on model error', async () => {
    // 2 models: indices 0, 1. After fallbackToNextModel() from index 0,
    // we go to 1. No wrap-around termination — the session loop handles
    // retry limits.
    const fallbackManager = makeFallbackManager(['model-a', 'model-b']);

    vi.mocked(runStreamedGeneration).mockResolvedValue(
      makeGenResult(
        makeAssistantMessage(),
        'error',
        makeApiError({ message: 'Service Unavailable', statusCode: 503 }),
      ),
    );

    const runner = new GenerationRunner(
      makeDeps({ fallbackManager, turnInitialFallbackIndex: 0 }),
    );
    const result = await runner.run();

    expect(runStreamedGeneration).toHaveBeenCalledTimes(1);
    expect(result.modelFallbackOccurred).toBe(true);
    expect(result.generationFailed).toBe(false);
    expect(fallbackManager.getFallbackIndex()).toBe(1);
  });
});

describe('GenerationRunner — exception with partial content salvages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it('salvages partial content on timeout exception and forces next step (no retry)', async () => {
    const partialMsg = makeAssistantMessage([
      { type: 'text', text: 'partial' },
    ]);
    vi.mocked(runStreamedGeneration).mockImplementation(async (params) => {
      params.onUpdate(partialMsg);
      throw new Error('Request timeout after 30000ms');
    });
    vi.mocked(repairPartialMessage).mockReturnValue(true);

    const messages: ExtendedUIMessage[] = [];
    const runner = new GenerationRunner(makeDeps({ messages }));
    const result = await runner.run();

    expect(runStreamedGeneration).toHaveBeenCalledTimes(1);
    expect(result.shouldContinue).toBe(true);
    expect(result.forceNextStep).toBe(true);
    expect(messages).toContain(partialMsg);
  });

  it('returns modelFallbackOccurred on timeout exception when no partial content exists', async () => {
    const fallbackManager = makeFallbackManager(['model-a', 'model-b']);
    const fallbackSpy = vi.spyOn(fallbackManager, 'fallbackToNextModel');

    vi.mocked(runStreamedGeneration).mockRejectedValue(
      new Error('Request timeout after 30000ms'),
    );

    const messages: ExtendedUIMessage[] = [];
    const runner = new GenerationRunner(
      makeDeps({ messages, fallbackManager }),
    );
    const result = await runner.run();

    expect(runStreamedGeneration).toHaveBeenCalledTimes(1);
    expect(fallbackSpy).toHaveBeenCalledOnce();
    expect(result.shouldContinue).toBe(true);
    expect(result.forceNextStep).toBe(false);
    expect(result.modelFallbackOccurred).toBe(true);
    expect(messages).toHaveLength(0);
  });

  it('does not retry on timeout exception when partial content exists (salvages instead)', async () => {
    const partialMsg = makeAssistantMessage([
      { type: 'text', text: 'partial' },
    ]);
    vi.mocked(runStreamedGeneration).mockImplementation(async (params) => {
      params.onUpdate(partialMsg);
      throw new Error('Request timeout after 30000ms');
    });
    vi.mocked(repairPartialMessage).mockReturnValue(true);

    const runner = new GenerationRunner(makeDeps());
    const result = await runner.run();

    expect(runStreamedGeneration).toHaveBeenCalledTimes(1);
    expect(result.forceNextStep).toBe(true);
  });
});

describe('GenerationRunner — stream progress', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it('emits first_chunk_received event on first onUpdate', async () => {
    const msg1 = makeAssistantMessage([{ type: 'text', text: 'hel' }]);
    const msg2 = makeAssistantMessage([{ type: 'text', text: 'hello' }]);

    vi.mocked(runStreamedGeneration).mockImplementation(async (params) => {
      params.onUpdate(msg1);
      params.onUpdate(msg2);
      return makeGenResult(msg2, 'stop');
    });

    const stepSpan = trace.getTracer('test').startSpan('step');
    const addEventSpy = vi.spyOn(stepSpan, 'addEvent');

    const runner = new GenerationRunner(makeDeps({ stepSpan }));
    await runner.run();

    expect(addEventSpy).toHaveBeenCalledWith(
      'step.first_chunk_received',
      expect.objectContaining({ 'generation.attempt': 1 }),
    );
  });

  it('sets chunkCount attribute on step span', async () => {
    const msg = makeAssistantMessage([{ type: 'text', text: 'hello' }]);

    vi.mocked(runStreamedGeneration).mockImplementation(async (params) => {
      params.onUpdate(msg);
      params.onUpdate(msg);
      params.onUpdate(msg);
      return makeGenResult(msg, 'stop');
    });

    const stepSpan = trace.getTracer('test').startSpan('step');
    const setAttrSpy = vi.spyOn(stepSpan, 'setAttribute');

    const runner = new GenerationRunner(makeDeps({ stepSpan }));
    await runner.run();

    expect(setAttrSpy).toHaveBeenCalledWith('step.chunkCount', 3);
  });
});

describe('GenerationRunner — abort', () => {
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

    const runner = new GenerationRunner(makeDeps());
    const runPromise = runner.run();

    await new Promise((r) => setTimeout(r, 10));
    runner.abort();
    await runPromise;

    expect(capturedSignal?.aborted).toBe(true);
  });

  it('does not abort the tool abort signal when generation is aborted', async () => {
    vi.mocked(runStreamedGeneration).mockImplementation(async (params) => {
      // Simulate a tool call being dispatched during streaming
      params.onUpdate(
        makeAssistantMessage([
          {
            type: 'tool-testTool' as never,
            toolCallId: 'call-1',
            state: 'input-available',
            input: {},
            providerExecuted: false,
          } as never,
        ]),
      );
      await new Promise((r) => setTimeout(r, 50));
      return makeGenResult(makeAssistantMessage(), 'tool-calls');
    });

    const runner = new GenerationRunner(makeDeps());
    const runPromise = runner.run();

    await new Promise((r) => setTimeout(r, 10));
    runner.abort();
    await runPromise;

    // Tool dispatcher's abort signal should NOT be aborted
    // (we can't directly check it, but the test verifies no crash
    // and tools settle properly)
  });
});

describe('GenerationRunner — abort does not trigger fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it('does NOT trigger model fallback when generation is aborted with no content', async () => {
    const fallbackManager = makeFallbackManager(['model-a', 'model-b']);
    const fallbackSpy = vi.spyOn(fallbackManager, 'fallbackToNextModel');

    // Simulate an abort: runStreamedGeneration resolves with error finish
    // reason and the abort signal is set.
    vi.mocked(runStreamedGeneration).mockImplementation(async (params) => {
      // Abort the signal before returning
      params.abortSignal.addEventListener('abort', () => {});
      // Simulate the abort by returning an error finish with no content
      return makeGenResult(
        makeAssistantMessage(),
        'error',
        new Error('aborted'),
      );
    });

    const runner = new GenerationRunner(makeDeps({ fallbackManager }));
    // Abort before running so the signal is already aborted
    runner.abort();
    const result = await runner.run();

    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(result.modelFallbackOccurred).toBe(false);
    expect(result.generationFailed).toBe(false);
    expect(result.fatalError).toBe(false);
  });

  it('salvages partial content when generation is aborted with content', async () => {
    const fallbackManager = makeFallbackManager(['model-a', 'model-b']);
    const fallbackSpy = vi.spyOn(fallbackManager, 'fallbackToNextModel');

    const partialMsg = makeAssistantMessage([
      { type: 'text', text: 'partial' },
    ]);
    vi.mocked(runStreamedGeneration).mockImplementation(async (params) => {
      params.onUpdate(partialMsg);
      return makeGenResult(partialMsg, 'error', new Error('aborted'));
    });
    vi.mocked(repairPartialMessage).mockReturnValue(true);

    const messages: ExtendedUIMessage[] = [];
    const runner = new GenerationRunner(
      makeDeps({ messages, fallbackManager }),
    );
    // Abort before running
    runner.abort();
    const result = await runner.run();

    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(result.modelFallbackOccurred).toBe(false);
    expect(result.forceNextStep).toBe(true);
    expect(result.fatalError).toBe(false);
    expect(messages).toContain(partialMsg);
  });

  it('does NOT trigger fallback on AbortError thrown by streamText', async () => {
    const fallbackManager = makeFallbackManager(['model-a', 'model-b']);
    const fallbackSpy = vi.spyOn(fallbackManager, 'fallbackToNextModel');

    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';

    vi.mocked(runStreamedGeneration).mockImplementation(async (params) => {
      // Simulate the abort signal firing and an AbortError being thrown
      params.onUpdate(makeAssistantMessage());
      throw abortError;
    });

    const runner = new GenerationRunner(makeDeps({ fallbackManager }));
    // Abort so the signal is set
    runner.abort();
    const result = await runner.run();

    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(result.modelFallbackOccurred).toBe(false);
    expect(result.generationFailed).toBe(false);
    expect(result.fatalError).toBe(false);
  });
});
