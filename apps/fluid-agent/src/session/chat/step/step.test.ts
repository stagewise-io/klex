import { randomUUID } from 'node:crypto';

import { context } from '@opentelemetry/api';
import { isToolUIPart } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionInboxPriority } from '@/session/inbox';
import type { AgentTools } from '@/session/tools';
import type { ExtendedUIMessage } from '@/session/types';

import {
  testLogger as logger,
  makeExtensionHandler,
  makeFallbackManager,
  makeInbox,
  makeModelProvider,
} from '../test-helpers';
import {
  checkAndFixHistory,
  type HistoryRepairInfo,
} from '../utils/check-and-fix-history';
import { convertToModelMessagesExtended } from '../utils/convert-to-model-messages';
import {
  createGenerationRunner,
  type GenerationRunnerResult,
} from './generation-runner';
import { createStep, type StepDependencies, type StepResult } from './step';

// --- helpers ---

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

const SUCCESS_RESULT: GenerationRunnerResult = {
  shouldContinue: true,
  forceNextStep: false,
  fatalError: false,
  fatalErrorReason: null,
  generationFailed: false,
  usage: null,
};

// --- mocks ---

vi.mock('./generation-runner', () => ({
  createGenerationRunner: vi.fn(() => ({
    run: vi.fn(async () => SUCCESS_RESULT),
    abort: vi.fn(),
    abortTools: vi.fn(),
  })),
}));
vi.mock('../utils/check-and-fix-history', () => ({
  checkAndFixHistory: vi.fn(() => ({ repaired: [] })),
}));
vi.mock('../utils/convert-to-model-messages', () => ({
  convertToModelMessagesExtended: vi.fn(),
}));

function makeDeps(overrides: Partial<StepDependencies> = {}): StepDependencies {
  return {
    logger,
    turnContext: context.active(),
    messages: [],
    inbox: makeInbox(),
    extensionHandler: makeExtensionHandler() as never,
    tools: {} as AgentTools,
    modelProvider: makeModelProvider() as never,
    fallbackManager: makeFallbackManager() as never,
    sessionId: 'test-session-id',
    ...overrides,
  };
}

function setupDefaultMocks() {
  vi.mocked(checkAndFixHistory).mockImplementation(() => ({ repaired: [] }));
  vi.mocked(convertToModelMessagesExtended).mockResolvedValue([]);
}

// --- tests ---

describe('Step — decision: skip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it('returns { shouldContinue: false } when no messages exist', async () => {
    const step = createStep(makeDeps({ messages: [] }));
    const result = await step.run();
    expect(result).toEqual({
      shouldContinue: false,
      forceNextStep: false,
      fatalError: false,
      fatalErrorReason: null,
      generationFailed: false,
      usage: null,
    });
    expect(createGenerationRunner).not.toHaveBeenCalled();
  });

  it('returns { shouldContinue: false } when last assistant message has no tool calls', async () => {
    const step = createStep(
      makeDeps({
        messages: [
          makeUserMessage(),
          makeAssistantMessage([{ type: 'text', text: 'hi' }]),
        ],
      }),
    );
    const result = await step.run();
    expect(result).toEqual({
      shouldContinue: false,
      forceNextStep: false,
      fatalError: false,
      fatalErrorReason: null,
      generationFailed: false,
      usage: null,
    });
    expect(createGenerationRunner).not.toHaveBeenCalled();
  });

  it('proceeds when last assistant has unresolved tool calls — checkAndFixHistory repairs them first', async () => {
    // checkAndFixHistory runs before the step decision and converts
    // intermediate states (input-streaming, input-available) to
    // output-error. This prevents a stale tool call from permanently
    // sticking the session.
    vi.mocked(checkAndFixHistory).mockImplementation((history) => {
      const repaired: HistoryRepairInfo[] = [];
      for (const msg of history) {
        for (const p of msg.parts) {
          if (
            isToolUIPart(p) &&
            p.state !== 'output-available' &&
            p.state !== 'output-denied' &&
            p.state !== 'output-error'
          ) {
            const prev = p.state;
            (p as any).state = 'output-error';
            (p as any).errorText =
              'The tool call was not executed for unknown reasons. Try again.';
            repaired.push({
              messageId: msg.id,
              partType: p.type,
              toolCallId: p.toolCallId,
              previousState: prev,
              newState: 'output-error',
              errorText:
                'The tool call was not executed for unknown reasons. Try again.',
            });
          }
        }
      }
      return { repaired };
    });

    const step = createStep(
      makeDeps({
        messages: [
          makeUserMessage(),
          makeAssistantMessage([makeToolPart('call-1', 'input-streaming')]),
        ],
      }),
    );
    const result = await step.run();

    expect(result.shouldContinue).toBe(true);
    expect(createGenerationRunner).toHaveBeenCalledOnce();
    expect(checkAndFixHistory).toHaveBeenCalled();
  });
});

describe('Step — decision: proceed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it('proceeds when last message is a user message', async () => {
    const step = createStep(makeDeps({ messages: [makeUserMessage()] }));
    const result = await step.run();

    expect(result.shouldContinue).toBe(true);
    expect(createGenerationRunner).toHaveBeenCalledOnce();
  });

  it('proceeds when last assistant message has all tool calls resolved', async () => {
    const step = createStep(
      makeDeps({
        messages: [
          makeUserMessage(),
          makeAssistantMessage([makeToolPart('call-1', 'output-available')]),
        ],
      }),
    );
    const result = await step.run();

    expect(result.shouldContinue).toBe(true);
    expect(createGenerationRunner).toHaveBeenCalledOnce();
  });

  it('proceeds when last assistant message has tool calls in output-denied state', async () => {
    const step = createStep(
      makeDeps({
        messages: [
          makeUserMessage(),
          makeAssistantMessage([makeToolPart('call-1', 'output-denied')]),
        ],
      }),
    );
    const result = await step.run();

    expect(result.shouldContinue).toBe(true);
    expect(createGenerationRunner).toHaveBeenCalledOnce();
  });

  it('proceeds when last assistant has mixed resolved states (output-available + output-denied)', async () => {
    const step = createStep(
      makeDeps({
        messages: [
          makeUserMessage(),
          makeAssistantMessage([
            makeToolPart('call-1', 'output-available'),
            makeToolPart('call-2', 'output-denied'),
          ]),
        ],
      }),
    );
    const result = await step.run();

    expect(result.shouldContinue).toBe(true);
    expect(createGenerationRunner).toHaveBeenCalledOnce();
  });

  it('proceeds when last assistant has mixed resolved and unresolved tool calls — repair fixes the unresolved ones', async () => {
    // Same as above: checkAndFixHistory runs before the decision and
    // converts the input-streaming part to output-error, so all tool
    // calls end up resolved and the step proceeds.
    vi.mocked(checkAndFixHistory).mockImplementation((history) => {
      const repaired: HistoryRepairInfo[] = [];
      for (const msg of history) {
        for (const p of msg.parts) {
          if (
            isToolUIPart(p) &&
            p.state !== 'output-available' &&
            p.state !== 'output-denied' &&
            p.state !== 'output-error'
          ) {
            const prev = p.state;
            (p as any).state = 'output-error';
            (p as any).errorText =
              'The tool call was not executed for unknown reasons. Try again.';
            repaired.push({
              messageId: msg.id,
              partType: p.type,
              toolCallId: p.toolCallId,
              previousState: prev,
              newState: 'output-error',
              errorText:
                'The tool call was not executed for unknown reasons. Try again.',
            });
          }
        }
      }
      return { repaired };
    });

    const step = createStep(
      makeDeps({
        messages: [
          makeUserMessage(),
          makeAssistantMessage([
            makeToolPart('call-1', 'output-available'),
            makeToolPart('call-2', 'input-streaming'),
          ]),
        ],
      }),
    );
    const result = await step.run();

    expect(result.shouldContinue).toBe(true);
    expect(createGenerationRunner).toHaveBeenCalledOnce();
  });
});

describe('Step — extension handler hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it('calls onHistoryPreProcessing with a structuredClone of the messages', async () => {
    const extensionHandler = makeExtensionHandler();
    extensionHandler.onHistoryPreProcessing.mockImplementation(
      async (h: ExtendedUIMessage[]) => {
        // Mutate the input — should NOT affect the original
        h.push(makeUserMessage('injected'));
        return { history: h, flags: {} };
      },
    );

    const originalMessages = [makeUserMessage('hello')];
    const step = createStep(
      makeDeps({
        messages: originalMessages,
        extensionHandler: extensionHandler as never,
      }),
    );
    await step.run();

    expect(extensionHandler.onHistoryPreProcessing).toHaveBeenCalledOnce();
    // Original must not be mutated
    expect(originalMessages).toHaveLength(1);
    expect(originalMessages[0]?.parts[0]).toEqual({
      type: 'text',
      text: 'hello',
    });
  });

  it('calls onHistoryPostProcessing with the converted model messages', async () => {
    const extensionHandler = makeExtensionHandler();
    extensionHandler.onHistoryPostProcessing.mockResolvedValue({
      history: [],
      flags: {},
    });

    const step = createStep(
      makeDeps({
        messages: [makeUserMessage()],
        extensionHandler: extensionHandler as never,
      }),
    );
    await step.run();

    expect(extensionHandler.onHistoryPostProcessing).toHaveBeenCalledOnce();
  });

  it('uses the history from onHistoryPreProcessing for conversion', async () => {
    const extensionHandler = makeExtensionHandler();
    const preProcessedHistory = [makeUserMessage('pre-processed')];
    extensionHandler.onHistoryPreProcessing.mockResolvedValue({
      history: preProcessedHistory,
      flags: {},
    });

    const step = createStep(
      makeDeps({
        messages: [makeUserMessage()],
        extensionHandler: extensionHandler as never,
      }),
    );
    await step.run();

    expect(convertToModelMessagesExtended).toHaveBeenCalledWith(
      preProcessedHistory,
    );
  });

  it('uses the model messages from onHistoryPostProcessing for generation', async () => {
    const extensionHandler = makeExtensionHandler();
    const postProcessedMessages = [
      { role: 'user', content: [{ type: 'text', text: 'post' }] },
    ] as never;
    extensionHandler.onHistoryPostProcessing.mockResolvedValue({
      history: postProcessedMessages,
      flags: {},
    });

    const step = createStep(
      makeDeps({
        messages: [makeUserMessage()],
        extensionHandler: extensionHandler as never,
      }),
    );
    await step.run();

    const createCall = vi.mocked(createGenerationRunner).mock.calls[0]?.[0];
    expect(createCall?.modelMessages).toBe(postProcessedMessages);
  });
});

describe('Step — compacted flag propagation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it('passes compacted=false to GenerationRunner when no extension flag is set', async () => {
    const extensionHandler = makeExtensionHandler();
    extensionHandler.onHistoryPreProcessing.mockResolvedValue({
      history: [],
      flags: {},
    });

    const step = createStep(
      makeDeps({
        messages: [makeUserMessage()],
        extensionHandler: extensionHandler as never,
      }),
    );
    await step.run();

    const createCall = vi.mocked(createGenerationRunner).mock.calls[0]?.[0];
    expect(createCall?.compacted).toBe(false);
  });

  it('passes compacted=true when onHistoryPreProcessing sets hasCompacted flag', async () => {
    const extensionHandler = makeExtensionHandler();
    extensionHandler.onHistoryPreProcessing.mockResolvedValue({
      history: [],
      flags: { hasCompacted: true },
    });

    const step = createStep(
      makeDeps({
        messages: [makeUserMessage()],
        extensionHandler: extensionHandler as never,
      }),
    );
    await step.run();

    const createCall = vi.mocked(createGenerationRunner).mock.calls[0]?.[0];
    expect(createCall?.compacted).toBe(true);
  });
});

describe('Step — model selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it('fetches the model from modelProvider using fallbackManager.getChatModelId', async () => {
    const modelProvider = makeModelProvider();
    const fallbackManager = makeFallbackManager();
    fallbackManager.getChatModelId.mockReturnValue('model:claude-3' as never);

    const step = createStep(
      makeDeps({
        messages: [makeUserMessage()],
        modelProvider: modelProvider as never,
        fallbackManager: fallbackManager as never,
      }),
    );
    await step.run();

    expect(fallbackManager.getChatModelId).toHaveBeenCalled();
    expect(modelProvider.get).toHaveBeenCalledWith('model:claude-3');
  });
});

describe('Step — structuredClone isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it('does not mutate original messages when extension mutates the pre-processing history', async () => {
    const originalMessages = [makeUserMessage('hello')];
    const extensionHandler = makeExtensionHandler();

    extensionHandler.onHistoryPreProcessing.mockImplementation(
      async (h: ExtendedUIMessage[]) => {
        h.push(makeUserMessage('injected by extension'));
        return { history: h, flags: {} };
      },
    );

    const step = createStep(
      makeDeps({
        messages: originalMessages,
        extensionHandler: extensionHandler as never,
      }),
    );
    await step.run();

    expect(originalMessages[0]?.parts[0]).toEqual({
      type: 'text',
      text: 'hello',
    });
    const injectedPresent = originalMessages.some(
      (m) =>
        m.role === 'user' &&
        m.parts.some(
          (p) => p.type === 'text' && p.text === 'injected by extension',
        ),
    );
    expect(injectedPresent).toBe(false);
  });
});

describe('Step — GenerationRunner result passthrough', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it('returns the GenerationRunner result directly', async () => {
    const genResult: GenerationRunnerResult = {
      shouldContinue: true,
      forceNextStep: true,
      fatalError: false,
      fatalErrorReason: null,
      generationFailed: false,
      usage: null,
    };
    vi.mocked(createGenerationRunner).mockReturnValue({
      run: vi.fn(async () => genResult),
      abort: vi.fn(),
      abortTools: vi.fn(),
    } as never);

    const step = createStep(makeDeps({ messages: [makeUserMessage()] }));
    const result = await step.run();

    expect(result).toEqual(genResult);
  });

  it('returns generationFailed result from GenerationRunner', async () => {
    const genResult: GenerationRunnerResult = {
      shouldContinue: false,
      forceNextStep: false,
      fatalError: false,
      fatalErrorReason: null,
      generationFailed: true,
      usage: null,
    };
    vi.mocked(createGenerationRunner).mockReturnValue({
      run: vi.fn(async () => genResult),
      abort: vi.fn(),
      abortTools: vi.fn(),
    } as never);

    const step = createStep(makeDeps({ messages: [makeUserMessage()] }));
    const result = await step.run();

    expect(result.generationFailed).toBe(true);
    expect(result.shouldContinue).toBe(false);
  });
});

describe('Step — abort', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it('delegates abort to the GenerationRunner', async () => {
    const abortFn = vi.fn();
    let resolveRun: ((v: StepResult) => void) | undefined;
    vi.mocked(createGenerationRunner).mockReturnValue({
      run: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveRun = resolve;
          }),
      ),
      abort: abortFn,
      abortTools: vi.fn(),
    } as never);

    const step = createStep(makeDeps({ messages: [makeUserMessage()] }));
    const runPromise = step.run();

    await new Promise((r) => setTimeout(r, 10));
    step.abortGeneration('test-abort');

    expect(abortFn).toHaveBeenCalledWith('test-abort');

    resolveRun?.(SUCCESS_RESULT as StepResult);
    await runPromise;
  });

  it('delegates abortTools to the GenerationRunner', async () => {
    const abortToolsFn = vi.fn();
    let resolveRun: ((v: StepResult) => void) | undefined;
    vi.mocked(createGenerationRunner).mockReturnValue({
      run: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveRun = resolve;
          }),
      ),
      abort: vi.fn(),
      abortTools: abortToolsFn,
    } as never);

    const step = createStep(makeDeps({ messages: [makeUserMessage()] }));
    const runPromise = step.run();

    await new Promise((r) => setTimeout(r, 10));
    step.abortTools();

    expect(abortToolsFn).toHaveBeenCalledOnce();

    resolveRun?.(SUCCESS_RESULT as StepResult);
    await runPromise;
  });

  it('does not throw when abortGeneration is called before run starts', () => {
    const step = createStep(makeDeps({ messages: [] }));
    expect(() => step.abortGeneration()).not.toThrow();
  });

  it('does not throw when abortTools is called before run starts', () => {
    const step = createStep(makeDeps({ messages: [] }));
    expect(() => step.abortTools()).not.toThrow();
  });
});
