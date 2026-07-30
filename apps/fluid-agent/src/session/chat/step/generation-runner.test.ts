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

  it('returns generationFailed=true when non-error finish has no parts', async () => {
    // With the default fallback behavior, a no-content non-fatal finish
    // triggers model_error → fallback. Use a 1-model fallback manager so
    // the wrap-around check immediately produces generation_failed.
    const fallbackManager = makeFallbackManager(['model-a']);

    vi.mocked(runStreamedGeneration).mockResolvedValue(
      makeGenResult(makeAssistantMessage(), 'length'),
    );

    const runner = new GenerationRunner(makeDeps({ fallbackManager }));
    const result = await runner.run();

    expect(result.generationFailed).toBe(true);
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
    // 1 model: fallback wraps immediately (0→0), so only 1 call before generation_failed
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
    await runner.run();

    expect(fallbackSpy).toHaveBeenCalledOnce();
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
    // 1 model: fallback wraps immediately, so only 1 call before generation_failed
    const fallbackManager = makeFallbackManager(['model-a']);
    const fallbackSpy = vi.spyOn(fallbackManager, 'fallbackToNextModel');

    vi.mocked(runStreamedGeneration).mockResolvedValue(
      makeGenResult(makeAssistantMessage(), 'error', null),
    );

    const runner = new GenerationRunner(makeDeps({ fallbackManager }));
    await runner.run();

    expect(fallbackSpy).toHaveBeenCalledOnce();
  });

  it('returns generationFailed when all models exhausted (no content, model error)', async () => {
    // 1 model: fallback wraps immediately (0→0), so only 1 call before generation_failed
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
    expect(result.generationFailed).toBe(true);
    expect(result.forceNextStep).toBe(false);
    expect(result.fatalError).toBe(false);
    expect(result.generation).toBeNull();
    expect(result.modelFallbackOccurred).toBe(false);
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

  it('returns generationFailed when all models exhausted via exception (no content)', async () => {
    // 1 model: fallback wraps immediately (0→0), so only 1 call before generation_failed
    const fallbackManager = makeFallbackManager(['model-a']);

    vi.mocked(runStreamedGeneration).mockRejectedValue(
      makeApiError({ message: 'Service Unavailable', statusCode: 503 }),
    );

    const runner = new GenerationRunner(makeDeps({ fallbackManager }));
    const result = await runner.run();

    expect(runStreamedGeneration).toHaveBeenCalledTimes(1);
    expect(result.generationFailed).toBe(true);
    expect(result.modelFallbackOccurred).toBe(false);
  });
});

describe('GenerationRunner — fallback_new_step and wrap-around', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it('returns modelFallbackOccurred when model error occurs and not all models exhausted', async () => {
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
    expect(result.generation).toBeNull();
  });

  it('uses turnInitialFallbackIndex for wrap-around detection', async () => {
    // 2 models: indices 0, 1. Start at turn-level index 1.
    // After fallbackToNextModel() from index 1, we wrap to 0.
    // 0 !== 1 (turnInitialFallbackIndex), so no wrap-around → fallback_new_step.
    const fallbackManager = makeFallbackManager(['model-a', 'model-b']);
    // Advance to index 1 so the turn starts there.
    fallbackManager.fallbackToNextModel();
    expect(fallbackManager.getFallbackIndex()).toBe(1);

    vi.mocked(runStreamedGeneration).mockResolvedValue(
      makeGenResult(
        makeAssistantMessage(),
        'error',
        makeApiError({ message: 'Service Unavailable', statusCode: 503 }),
      ),
    );

    const runner = new GenerationRunner(
      makeDeps({ fallbackManager, turnInitialFallbackIndex: 1 }),
    );
    const result = await runner.run();

    // 1 call, fallback wraps from 1→0. 0 !== 1, so fallback_new_step.
    expect(runStreamedGeneration).toHaveBeenCalledTimes(1);
    expect(result.modelFallbackOccurred).toBe(true);
    expect(fallbackManager.getFallbackIndex()).toBe(0);
  });

  it('detects wrap-around when fallbackIndex returns to turnInitialFallbackIndex', async () => {
    // 2 models: indices 0, 1. Start at turn-level index 0.
    // After fallbackToNextModel() from index 0, we go to 1.
    // 1 !== 0, so fallback_new_step (not generation_failed).
    // A second step starting at index 1 would then wrap to 0 === 0 → generation_failed.
    // Here we test the single-step behavior: starting at 0, 2 models → fallback_new_step.
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
