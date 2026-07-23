import { context, trace } from '@opentelemetry/api';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleLogger } from '@stagewise/logger';

import { type SessionInboxBuffer, SessionInboxPriority } from '@/session/inbox';
import type { AgentTools } from '@/session/tools';
import type { ExtendedUIMessage } from '@/session/types';

import { createStep, type StepResult } from '../step';
import { drainInbox } from '../utils/drain-inbox';
import { createTurn, type TurnDependencies } from './turn';

// --- mocks (hoisted by vitest) ---

vi.mock('../step', () => ({
  createStep: vi.fn(),
}));
vi.mock('../utils/drain-inbox', () => ({
  drainInbox: vi.fn(),
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
    get: vi.fn().mockResolvedValue({}),
    start: vi.fn(),
    close: vi.fn(),
  };
}

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
    tools: {} as AgentTools,
    modelProvider: makeModelProvider() as never,
    getChatModelId: vi.fn(() => 'test:model' as never),
    getModelFallbackIndex: vi.fn(() => 0),
    fallbackToNextModel: vi.fn(),
    ...overrides,
  };
}

function makeMockStep(runResult: StepResult, delay = 0) {
  return {
    run: vi.fn(async () => {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      return runResult;
    }),
    abortGeneration: vi.fn(),
  };
}

const emptyDrainResult = {
  total: 0,
  byPriority: { low: 0, medium: 0, high: 0 },
};

// --- tests ---

describe('Turn — inbox draining', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(drainInbox).mockReturnValue(emptyDrainResult);
  });

  it('drains inbox at Low priority at the start of the turn', async () => {
    const step = makeMockStep({ hadGeneration: false, forceNextStep: false });
    vi.mocked(createStep).mockReturnValue(step);

    const turn = createTurn(makeDeps());
    await turn.run();

    expect(drainInbox).toHaveBeenCalledOnce();
    expect(drainInbox).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      SessionInboxPriority.Low,
      expect.anything(),
    );
  });
});

describe('Turn — step loop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(drainInbox).mockReturnValue(emptyDrainResult);
  });

  it('runs steps until a step returns { hadGeneration: false }', async () => {
    const step1 = makeMockStep({ hadGeneration: true, forceNextStep: false });
    const step2 = makeMockStep({ hadGeneration: true, forceNextStep: false });
    const step3 = makeMockStep({ hadGeneration: false, forceNextStep: false });

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

  it('runs exactly one step when it returns { hadGeneration: false } immediately', async () => {
    const step = makeMockStep({ hadGeneration: false, forceNextStep: false });
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
    vi.mocked(drainInbox).mockReturnValue(emptyDrainResult);
  });

  it('delegates abortGeneration to the current step', async () => {
    const step = makeMockStep(
      { hadGeneration: false, forceNextStep: false },
      50,
    );
    vi.mocked(createStep).mockReturnValue(step);

    const turn = createTurn(makeDeps());
    const runPromise = turn.run();

    await new Promise((r) => setTimeout(r, 10));
    turn.abortGeneration();
    await runPromise;

    expect(step.abortGeneration).toHaveBeenCalledOnce();
  });

  it('does not call abortGeneration on a null current step (after loop ends)', async () => {
    const step = makeMockStep({ hadGeneration: false, forceNextStep: false });
    vi.mocked(createStep).mockReturnValue(step);

    const turn = createTurn(makeDeps());
    await turn.run();

    // After run completes, currentStep is null — should be a no-op
    expect(() => turn.abortGeneration()).not.toThrow();
    expect(step.abortGeneration).not.toHaveBeenCalled();
  });
});

describe('Turn — force continue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(drainInbox).mockReturnValue(emptyDrainResult);
  });

  it('injects a "Continue." user message when forceNextStep is true and last message is not user', async () => {
    // Step 1: generation with forceNextStep=true (e.g. truncated output)
    // Step 2: no generation — loop ends
    const step1 = makeMockStep({ hadGeneration: true, forceNextStep: true });
    const step2 = makeMockStep({ hadGeneration: false, forceNextStep: false });
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

    // A "Continue." user message should have been injected before step 2
    const continueMsg = messages.find(
      (m) =>
        m.role === 'user' &&
        m.parts.some((p) => p.type === 'text' && p.text === 'Continue.'),
    );
    expect(continueMsg).toBeDefined();
  });

  it('does not inject "Continue." when forceNextStep is false', async () => {
    const step1 = makeMockStep({ hadGeneration: true, forceNextStep: false });
    const step2 = makeMockStep({ hadGeneration: false, forceNextStep: false });
    vi.mocked(createStep).mockReturnValueOnce(step1).mockReturnValueOnce(step2);

    const messages: ExtendedUIMessage[] = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hello' }] },
    ] as ExtendedUIMessage[];

    const turn = createTurn(makeDeps({ messages }));
    await turn.run();

    const continueMsg = messages.find(
      (m) =>
        m.role === 'user' &&
        m.parts.some((p) => p.type === 'text' && p.text === 'Continue.'),
    );
    expect(continueMsg).toBeUndefined();
  });

  it('does not inject "Continue." when last message is already a user message', async () => {
    const step1 = makeMockStep({ hadGeneration: true, forceNextStep: true });
    const step2 = makeMockStep({ hadGeneration: false, forceNextStep: false });
    vi.mocked(createStep).mockReturnValueOnce(step1).mockReturnValueOnce(step2);

    const messages: ExtendedUIMessage[] = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hello' }] },
    ] as ExtendedUIMessage[];

    const turn = createTurn(makeDeps({ messages }));
    await turn.run();

    // Last message is already user — no need to inject
    const continueCount = messages.filter(
      (m) =>
        m.role === 'user' &&
        m.parts.some((p) => p.type === 'text' && p.text === 'Continue.'),
    ).length;
    expect(continueCount).toBe(0);
  });

  it('passes fallbackToNextModel to each created step', async () => {
    const fallbackFn = vi.fn();
    const step1 = makeMockStep({ hadGeneration: true, forceNextStep: true });
    const step2 = makeMockStep({ hadGeneration: false, forceNextStep: false });
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
      makeDeps({ messages, fallbackToNextModel: fallbackFn }),
    );
    await turn.run();

    expect(createStep).toHaveBeenCalledTimes(2);
    const firstCallArgs = vi.mocked(createStep).mock.calls[0]?.[0];
    expect(firstCallArgs?.fallbackToNextModel).toBe(fallbackFn);
  });
});
