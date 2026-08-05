import { context, trace } from '@opentelemetry/api';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { StepCompleteEvent } from '../extensions/extension-api';
import { SessionInboxPriority } from '../inbox';
import type { ExtendedUIMessage } from '../message-types';
import { createStep } from '../step';
import {
  testLogger as logger,
  makeExtensionHandler,
  makeFallbackManager,
  makeInbox,
  makeModelProvider,
} from '../test-helpers';
import { createTurn, type TurnDependencies } from './turn';

// --- mocks (hoisted by vitest) ---

vi.mock('../step', () => ({
  createStep: vi.fn(),
}));

function makeDeps(overrides: Partial<TurnDependencies> = {}): TurnDependencies {
  const sessionSpan = trace.getTracer('test').startSpan('session');
  const sessionContext = trace.setSpan(context.active(), sessionSpan);

  return {
    logger,
    sessionId: 'session-test',
    sessionContext,
    sessionSpan,
    messages: [],
    inbox: makeInbox(),
    extensionHandler: makeExtensionHandler() as never,
    modelProvider: makeModelProvider() as never,
    fallbackManager: makeFallbackManager() as never,
    config: {
      resolveModel: vi.fn(() => ({
        modelId: 'test:model',
        contextSize: 128_000,
      })),
    } as never,
    ...overrides,
  };
}

/** Standard no-op step result — tests override individual fields as needed. */
const NOOP_RESULT: StepCompleteEvent = {
  shouldContinue: false,
  forceNextStep: false,
  fatalError: false,
  fatalErrorReason: null,
  generationFailed: false,
  generation: null,
  toolCalls: [],
  modelFallbackOccurred: false,
};

function makeMockStep(overrides: Partial<StepCompleteEvent> = {}, delay = 0) {
  const runResult: StepCompleteEvent = { ...NOOP_RESULT, ...overrides };
  return {
    run: vi.fn(async () => {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      return runResult;
    }),
    abortGeneration: vi.fn(),
    abortTools: vi.fn(),
  };
}

// --- tests ---

describe('Turn — inbox draining', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('drains inbox at Low priority at the start of the turn', async () => {
    const step = makeMockStep();
    vi.mocked(createStep).mockReturnValue(step);

    const inbox = makeInbox();
    const turn = createTurn(makeDeps({ inbox }));
    await turn.run();

    expect(inbox.drain).toHaveBeenCalledOnce();
    expect(inbox.drain).toHaveBeenCalledWith(
      expect.anything(),
      SessionInboxPriority.Low,
      expect.anything(),
    );
  });
});

describe('Turn — step loop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs steps until a step returns { shouldContinue: false }', async () => {
    const step1 = makeMockStep({ shouldContinue: true });
    const step2 = makeMockStep({ shouldContinue: true });
    const step3 = makeMockStep({ shouldContinue: false });

    vi.mocked(createStep)
      .mockReturnValueOnce(step1)
      .mockReturnValueOnce(step2)
      .mockReturnValueOnce(step3);

    const turn = createTurn(makeDeps());
    await turn.run();

    expect(step1.run).toHaveBeenCalledOnce();
    expect(step2.run).toHaveBeenCalledOnce();
    expect(step3.run).toHaveBeenCalledOnce();
    expect(createStep).toHaveBeenCalledTimes(3);
  });

  it('runs exactly one step when it returns { shouldContinue: false } immediately', async () => {
    const step = makeMockStep({ shouldContinue: false });
    vi.mocked(createStep).mockReturnValue(step);

    const turn = createTurn(makeDeps());
    await turn.run();

    expect(step.run).toHaveBeenCalledOnce();
    expect(createStep).toHaveBeenCalledOnce();
  });
});

describe('Turn — abort', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates abortGeneration to the current step', async () => {
    const step = makeMockStep({}, 50);
    vi.mocked(createStep).mockReturnValue(step);

    const turn = createTurn(makeDeps());
    const runPromise = turn.run();

    await new Promise((r) => setTimeout(r, 10));
    turn.abortGeneration();
    await runPromise;

    expect(step.abortGeneration).toHaveBeenCalledOnce();
  });

  it('does not call abortGeneration on a null current step (after loop ends)', async () => {
    const step = makeMockStep();
    vi.mocked(createStep).mockReturnValue(step);

    const turn = createTurn(makeDeps());
    await turn.run();

    // After run completes, currentStep is null — should be a no-op
    expect(() => turn.abortGeneration()).not.toThrow();
    expect(step.abortGeneration).not.toHaveBeenCalled();
  });

  it('delegates abortTools to the current step', async () => {
    const step = makeMockStep({}, 50);
    vi.mocked(createStep).mockReturnValue(step);

    const turn = createTurn(makeDeps());
    const runPromise = turn.run();

    await new Promise((r) => setTimeout(r, 10));
    turn.abortTools();
    await runPromise;

    expect(step.abortTools).toHaveBeenCalledOnce();
  });

  it('does not call abortTools on a null current step (after loop ends)', async () => {
    const step = makeMockStep();
    vi.mocked(createStep).mockReturnValue(step);

    const turn = createTurn(makeDeps());
    await turn.run();

    expect(() => turn.abortTools()).not.toThrow();
    expect(step.abortTools).not.toHaveBeenCalled();
  });
});

describe('Turn — force continue (unified)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('injects a "Continue." user message when forceNextStep is true and last message is assistant text-only', async () => {
    // Step 1: generation with forceNextStep=true (e.g. truncated output)
    // Step 2: no generation — loop ends
    const step1 = makeMockStep({ shouldContinue: true, forceNextStep: true });
    const step2 = makeMockStep({ shouldContinue: false });
    vi.mocked(createStep).mockReturnValueOnce(step1).mockReturnValueOnce(step2);

    const messages: ExtendedUIMessage[] = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hello' }] },
      {
        id: 'a1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'partial' }],
      },
    ] as ExtendedUIMessage[];

    const turn = createTurn(makeDeps({ messages }));
    await turn.run();

    // A continue user message should have been injected before step 2
    const continueMsg = messages.find(
      (m) =>
        m.role === 'user' && m.parts.some((p) => p.type === 'data-continue'),
    );
    expect(continueMsg).toBeDefined();
  });

  it('does not inject "Continue." when last message is assistant with tool calls', async () => {
    const step1 = makeMockStep({ shouldContinue: true, forceNextStep: true });
    const step2 = makeMockStep({ shouldContinue: false });
    vi.mocked(createStep).mockReturnValueOnce(step1).mockReturnValueOnce(step2);

    const messages: ExtendedUIMessage[] = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hello' }] },
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'calling tool' },
          {
            type: 'tool-someTool' as never,
            toolCallId: 'call-1',
            state: 'input-available',
            input: {},
            providerExecuted: false,
          } as never,
        ],
      },
    ] as ExtendedUIMessage[];

    const turn = createTurn(makeDeps({ messages }));
    await turn.run();

    // Tool results prompt continuation naturally — no Continue needed
    const continueMsg = messages.find(
      (m) =>
        m.role === 'user' && m.parts.some((p) => p.type === 'data-continue'),
    );
    expect(continueMsg).toBeUndefined();
  });

  it('does not inject "Continue." when forceNextStep is false', async () => {
    const step1 = makeMockStep({ shouldContinue: true });
    const step2 = makeMockStep({ shouldContinue: false });
    vi.mocked(createStep).mockReturnValueOnce(step1).mockReturnValueOnce(step2);

    const messages: ExtendedUIMessage[] = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hello' }] },
    ] as ExtendedUIMessage[];

    const turn = createTurn(makeDeps({ messages }));
    await turn.run();

    const continueMsg = messages.find(
      (m) =>
        m.role === 'user' && m.parts.some((p) => p.type === 'data-continue'),
    );
    expect(continueMsg).toBeUndefined();
  });

  it('does not inject "Continue." when last message is a user message', async () => {
    const step1 = makeMockStep({ shouldContinue: true, forceNextStep: true });
    const step2 = makeMockStep({ shouldContinue: false });
    vi.mocked(createStep).mockReturnValueOnce(step1).mockReturnValueOnce(step2);

    const messages: ExtendedUIMessage[] = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hello' }] },
    ] as ExtendedUIMessage[];

    const turn = createTurn(makeDeps({ messages }));
    await turn.run();

    // Last message is already user — no need to inject
    const continueCount = messages.filter(
      (m) =>
        m.role === 'user' && m.parts.some((p) => p.type === 'data-continue'),
    ).length;
    expect(continueCount).toBe(0);
  });

  it('passes fallbackManager to each created step', async () => {
    const fallbackManager = makeFallbackManager();
    const step1 = makeMockStep({ shouldContinue: true, forceNextStep: true });
    const step2 = makeMockStep({ shouldContinue: false });
    vi.mocked(createStep).mockReturnValueOnce(step1).mockReturnValueOnce(step2);

    const messages: ExtendedUIMessage[] = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      {
        id: 'a1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'partial' }],
      },
    ] as ExtendedUIMessage[];

    const turn = createTurn(
      makeDeps({ messages, fallbackManager: fallbackManager as never }),
    );
    await turn.run();

    expect(createStep).toHaveBeenCalledTimes(2);
    const firstCallArgs = vi.mocked(createStep).mock.calls[0]?.[0];
    expect(firstCallArgs?.fallbackManager).toBe(fallbackManager);
  });
});

describe('Turn — fatal error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns fatalError when a step reports a fatal error', async () => {
    const fatalStep = makeMockStep({ shouldContinue: true, fatalError: true });
    vi.mocked(createStep).mockReturnValue(fatalStep);

    const turn = createTurn(makeDeps());
    const result = await turn.run();

    expect(result.fatalError).toBe(true);
    // Should only run one step — fatal stops immediately
    expect(fatalStep.run).toHaveBeenCalledOnce();
  });

  it('returns completeFailure when generationFailed is true', async () => {
    // Simulates all generation attempts exhausted within a single step.
    const step = makeMockStep({ generationFailed: true });
    vi.mocked(createStep).mockReturnValue(step);

    const turn = createTurn(makeDeps());
    const result = await turn.run();

    expect(result.fatalError).toBe(false);
    expect(result.completeFailure).toBe(true);
  });

  it('returns completeFailure=false when at least one step succeeds', async () => {
    const successStep = makeMockStep({ shouldContinue: true });
    const endStep = makeMockStep({ shouldContinue: false });
    vi.mocked(createStep)
      .mockReturnValueOnce(successStep)
      .mockReturnValueOnce(endStep);

    const turn = createTurn(makeDeps());
    const result = await turn.run();

    expect(result.fatalError).toBe(false);
    expect(result.completeFailure).toBe(false);
  });

  it('returns completeFailure=false when no step attempted generation', async () => {
    // No generation attempted — e.g. inbox drained but nothing to process.
    // This is a normal idle turn, not a failure.
    const step = makeMockStep({ shouldContinue: false });
    vi.mocked(createStep).mockReturnValue(step);

    const turn = createTurn(makeDeps());
    const result = await turn.run();

    expect(result.fatalError).toBe(false);
    expect(result.completeFailure).toBe(false);
  });

  it('returns completeFailure=false when all steps salvage content but none succeed cleanly', async () => {
    // Steps return shouldContinue=true, forceNextStep=true (salvaged) then
    // shouldContinue=false (no more generation). Content was produced, so
    // this is NOT a complete failure — the turn goes idle instead of backoff.
    const step1 = makeMockStep({ shouldContinue: true, forceNextStep: true });
    const step2 = makeMockStep({
      shouldContinue: false,
      generationFailed: false,
    });
    vi.mocked(createStep).mockReturnValueOnce(step1).mockReturnValueOnce(step2);

    const turn = createTurn(makeDeps());
    const result = await turn.run();

    expect(result.fatalError).toBe(false);
    expect(result.completeFailure).toBe(false);
  });
});

describe('Turn — modelFallbackOccurred handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('continues to next step when modelFallbackOccurred is true', async () => {
    const step1 = makeMockStep({
      shouldContinue: true,
      modelFallbackOccurred: true,
    });
    const step2 = makeMockStep({ shouldContinue: false });
    vi.mocked(createStep).mockReturnValueOnce(step1).mockReturnValueOnce(step2);

    const turn = createTurn(makeDeps());
    await turn.run();

    expect(step1.run).toHaveBeenCalledOnce();
    expect(step2.run).toHaveBeenCalledOnce();
    expect(createStep).toHaveBeenCalledTimes(2);
  });

  it('counts modelFallbackOccurred as failure for completeFailure', async () => {
    // Only step: modelFallbackOccurred with shouldContinue=true.
    // Loop continues, then next step returns shouldContinue=false (no generation).
    // Since no step succeeded cleanly, completeFailure should be true.
    const step1 = makeMockStep({
      shouldContinue: true,
      modelFallbackOccurred: true,
    });
    const step2 = makeMockStep({ shouldContinue: false });
    vi.mocked(createStep).mockReturnValueOnce(step1).mockReturnValueOnce(step2);

    const turn = createTurn(makeDeps());
    const result = await turn.run();

    expect(result.completeFailure).toBe(true);
  });

  it('does not inject Continue. when modelFallbackOccurred is true', async () => {
    const step1 = makeMockStep({
      shouldContinue: true,
      modelFallbackOccurred: true,
    });
    const step2 = makeMockStep({ shouldContinue: false });
    vi.mocked(createStep).mockReturnValueOnce(step1).mockReturnValueOnce(step2);

    const messages: ExtendedUIMessage[] = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hello' }] },
      {
        id: 'a1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'hi' }],
      },
    ] as ExtendedUIMessage[];

    const turn = createTurn(makeDeps({ messages }));
    await turn.run();

    const continueMsg = messages.find(
      (m) =>
        m.role === 'user' && m.parts.some((p) => p.type === 'data-continue'),
    );
    expect(continueMsg).toBeUndefined();
  });

  it('passes turnInitialFallbackIndex (captured at turn start) to every createStep call', async () => {
    // Use a stateful fallback manager so getFallbackIndex reflects advances.
    let index = 1;
    const fallbackManager = {
      getChatModelEntry: vi.fn(() => 'test:model' as never),
      getFallbackIndex: vi.fn(() => index),
      fallbackToNextModel: vi.fn(() => {
        index = (index + 1) % 2;
      }),
      recordSuccessfulGeneration: vi.fn(),
    } as never;

    const step1 = makeMockStep({ shouldContinue: false });
    vi.mocked(createStep).mockReturnValue(step1);

    const turn = createTurn(
      makeDeps({ fallbackManager: fallbackManager as never }),
    );
    await turn.run();

    for (const call of vi.mocked(createStep).mock.calls) {
      expect(call[0]?.turnInitialFallbackIndex).toBe(1);
    }
  });

  it('runs a second step with the fallback model after modelFallbackOccurred and reports success', async () => {
    // Step 1: model error → fallback to next model, modelFallbackOccurred.
    // Step 2: clean success (shouldContinue: true, no flags) with the new model.
    // Step 3: natural end (shouldContinue: false).
    const step1 = makeMockStep({
      shouldContinue: true,
      modelFallbackOccurred: true,
    });
    const step2 = makeMockStep({
      shouldContinue: true,
      generation: {
        modelId: 'model-b',
        finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 5 } as never,
      },
    });
    const step3 = makeMockStep({ shouldContinue: false });
    vi.mocked(createStep)
      .mockReturnValueOnce(step1)
      .mockReturnValueOnce(step2)
      .mockReturnValueOnce(step3);

    const turn = createTurn(makeDeps());
    const result = await turn.run();

    expect(createStep).toHaveBeenCalledTimes(3);
    // Step 1 failed (fallback), step 2 succeeded → not a complete failure.
    expect(result.completeFailure).toBe(false);
    expect(result.fatalError).toBe(false);
  });

  it('stops when a step returns generationFailed (e.g. attempt cap reached)', async () => {
    // Step 1 fails with fallback (index 0→1).
    // Step 2: generation runner returns generationFailed because the
    // session-level attempt cap was reached (no wrap-around termination).
    // The turn stops because shouldContinue is false.
    const fallbackManager = makeFallbackManager();

    const step1 = makeMockStep({
      shouldContinue: true,
      modelFallbackOccurred: true,
    });
    const step2 = makeMockStep({
      shouldContinue: false,
      generationFailed: true,
    });
    vi.mocked(createStep).mockReturnValueOnce(step1).mockReturnValueOnce(step2);

    const turn = createTurn(
      makeDeps({ fallbackManager: fallbackManager as never }),
    );
    const result = await turn.run();

    expect(createStep).toHaveBeenCalledTimes(2);
    // No step succeeded → complete failure.
    expect(result.completeFailure).toBe(true);
  });
});

describe('Turn — forceContinue (backoff retry)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('injects a "Continue." message when forceContinue is true and last message is assistant text-only', async () => {
    const step1 = makeMockStep({ shouldContinue: true });
    const step2 = makeMockStep({ shouldContinue: false });
    vi.mocked(createStep).mockReturnValueOnce(step1).mockReturnValueOnce(step2);

    const messages: ExtendedUIMessage[] = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hello' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'hi' }] },
    ] as ExtendedUIMessage[];

    const turn = createTurn(makeDeps({ messages, forceContinue: true }));
    await turn.run();

    const continueMsg = messages.find(
      (m) =>
        m.role === 'user' && m.parts.some((p) => p.type === 'data-continue'),
    );
    expect(continueMsg).toBeDefined();
  });

  it('does not inject "Continue." when forceContinue is true but last message is already user', async () => {
    const step1 = makeMockStep({ shouldContinue: true });
    const step2 = makeMockStep({ shouldContinue: false });
    vi.mocked(createStep).mockReturnValueOnce(step1).mockReturnValueOnce(step2);

    const messages: ExtendedUIMessage[] = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hello' }] },
    ] as ExtendedUIMessage[];

    const turn = createTurn(makeDeps({ messages, forceContinue: true }));
    await turn.run();

    const continueCount = messages.filter(
      (m) =>
        m.role === 'user' && m.parts.some((p) => p.type === 'data-continue'),
    ).length;
    expect(continueCount).toBe(0);
  });

  it('does not inject "Continue." when forceContinue is not set', async () => {
    const step1 = makeMockStep({ shouldContinue: true });
    const step2 = makeMockStep({ shouldContinue: false });
    vi.mocked(createStep).mockReturnValueOnce(step1).mockReturnValueOnce(step2);

    const messages: ExtendedUIMessage[] = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hello' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'hi' }] },
    ] as ExtendedUIMessage[];

    const turn = createTurn(makeDeps({ messages }));
    await turn.run();

    const continueMsg = messages.find(
      (m) =>
        m.role === 'user' && m.parts.some((p) => p.type === 'data-continue'),
    );
    expect(continueMsg).toBeUndefined();
  });
});
