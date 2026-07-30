import { randomUUID } from 'node:crypto';

import type { LanguageModelUsage } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExtendedUIMessage } from '../../message-types';
import type {
  ExtensionDeps,
  GenerateTextFailureReason,
  StepCompleteEvent,
} from '../extension-api';
import {
  CONTEXT_SIZE_THRESHOLD_RATIO,
  createContextCompactionExt,
  FALLBACK_COMPACTION_THRESHOLD,
  MAX_COMPACTION_THRESHOLD,
  MIN_MESSAGES_AFTER_SUMMARY,
  MIN_MESSAGES_BEFORE_SUMMARY_BY_ROLE,
} from './context-compaction';

// --- mocks ---

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    getToolName: (part: { type: string; toolName?: string }) =>
      part.toolName ?? part.type,
    isToolUIPart: (part: { type: string }) => part.type === 'tool',
  };
});

vi.mock('./compaction-prompt.md', () => ({
  default: 'You are a summarizer. Summarize the conversation.',
}));

beforeEach(() => {
  vi.clearAllMocks();
});

// --- helpers ---

function makeUsage(input: number, output: number): LanguageModelUsage {
  return {
    inputTokens: input,
    outputTokens: output,
  } as LanguageModelUsage;
}

function makeResult(usage: LanguageModelUsage | null): StepCompleteEvent {
  return {
    shouldContinue: true,
    forceNextStep: false,
    fatalError: false,
    fatalErrorReason: null,
    generationFailed: usage === null,
    generation:
      usage === null
        ? null
        : {
            modelId: 'test-model',
            finishReason: 'stop',
            usage,
          },
    toolCalls: [],
  };
}

function makeTextMessage(
  role: 'user' | 'assistant',
  text: string,
): ExtendedUIMessage {
  return {
    id: randomUUID(),
    role,
    parts: [{ type: 'text', text }],
  } as ExtendedUIMessage;
}

function makeToolCallMessage(
  toolName: string,
  input: unknown,
  output?: unknown,
  state:
    | 'output-available'
    | 'output-error'
    | 'output-denied' = 'output-available',
  errorText?: string,
): ExtendedUIMessage {
  const part: Record<string, unknown> = {
    type: 'tool',
    toolCallId: randomUUID(),
    toolName,
    input,
    state,
  };
  if (output !== undefined) part.output = output;
  if (errorText !== undefined) part.errorText = errorText;
  return {
    id: randomUUID(),
    role: 'assistant',
    parts: [part],
  } as ExtendedUIMessage;
}

function makeContextMessage(
  sourceEnv: string,
  text: string,
): ExtendedUIMessage {
  return {
    id: randomUUID(),
    role: 'user',
    parts: [
      {
        type: 'data-context',
        data: {
          sourceEnv,
          metadata: {},
          content: [{ type: 'text', text }],
        },
      },
    ],
  } as ExtendedUIMessage;
}

function makeSummaryMessage(summary: string): ExtendedUIMessage {
  return {
    id: randomUUID(),
    role: 'assistant',
    parts: [
      {
        type: 'data-context-summary',
        data: { summary },
      },
    ],
  } as ExtendedUIMessage;
}

function makeDeps(overrides?: Partial<ExtensionDeps>): ExtensionDeps {
  return {
    getHistory: vi.fn(() => []),
    insertMessageAfter: vi.fn(() => true),
    inbox: {
      send: vi.fn(),
      sendMessage: vi.fn(),
      close: vi.fn(),
    },
    config: {
      getModelSelection: vi.fn(() => ['remote:gpt-4o']),
      getModelContextSize: vi.fn(() => 20_000),
    } as unknown as ExtensionDeps['config'],
    generateText: vi.fn().mockResolvedValue(genFailure()),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
    } as unknown as ExtensionDeps['logger'],
    getDataDir: vi.fn(() => '/tmp/test-ext-data'),
    ...overrides,
  };
}

/** Builds a successful generateText result with zero-usage. */
function genSuccess(text: string): {
  success: true;
  text: string;
  modelId: string;
  usage: LanguageModelUsage;
} {
  return {
    success: true,
    text,
    modelId: 'test-model',
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      inputTokenDetails: {
        noCacheTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
      totalTokens: 0,
    } as LanguageModelUsage,
  };
}

/** Builds a failed generateText result. */
function genFailure(reason: GenerateTextFailureReason = 'all-models-failed'): {
  success: false;
  failureReason: GenerateTextFailureReason;
  failureDetails?: string;
} {
  return { success: false as const, failureReason: reason };
}

/** Flushes pending microtasks so fire-and-forget compaction can run. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// --- tests ---

describe('ContextCompactionExt — onStepComplete token accumulation', () => {
  it('accumulates inputTokens + outputTokens from usage', async () => {
    const deps = makeDeps();
    const ext = createContextCompactionExt.create(deps);

    await ext.onStepComplete!(makeResult(makeUsage(100, 50)));
    await ext.onStepComplete!(makeResult(makeUsage(200, 100)));

    // Not enough to trigger — no compaction call
    expect(deps.generateText).not.toHaveBeenCalled();
  });

  it('skips accumulation when usage is null (failed generation)', async () => {
    const deps = makeDeps();
    const ext = createContextCompactionExt.create(deps);

    await ext.onStepComplete!(makeResult(null));
    await ext.onStepComplete!(makeResult(null));

    expect(deps.generateText).not.toHaveBeenCalled();
  });

  it('does not trigger compaction when below threshold', async () => {
    const deps = makeDeps();
    const ext = createContextCompactionExt.create(deps);

    // FALLBACK_COMPACTION_THRESHOLD - 100 tokens total
    const half = FALLBACK_COMPACTION_THRESHOLD / 2;
    await ext.onStepComplete!(makeResult(makeUsage(half - 50, 0)));
    await ext.onStepComplete!(makeResult(makeUsage(half - 50, 0))); // total = threshold - 100

    expect(deps.generateText).not.toHaveBeenCalled();
  });

  it('preserves tokens accumulated during compaction (does not reset to 0)', async () => {
    const deps = makeDeps({
      getHistory: vi.fn(() => [
        makeTextMessage('user', 'Hello'),
        makeTextMessage('assistant', 'Hi there'),
      ]),
    });

    // Make compaction slow so we can accumulate tokens while it runs.
    let resolveGenerate!: (
      v: ReturnType<typeof genSuccess> | ReturnType<typeof genFailure>,
    ) => void;
    vi.mocked(deps.generateText)!.mockReturnValue(
      new Promise((resolve) => {
        resolveGenerate = resolve;
      }) as never,
    );

    const ext = createContextCompactionExt.create(deps);

    // Trigger compaction — accumulatedTokens = threshold
    await ext.onStepComplete!(
      makeResult(makeUsage(FALLBACK_COMPACTION_THRESHOLD, 0)),
    );
    await flushMicrotasks();

    // While compaction is in flight, add more tokens.
    const inflightTokens = 5_000;
    await ext.onStepComplete!(makeResult(makeUsage(inflightTokens, 0)));
    await flushMicrotasks();

    // Only one compaction call — second was suppressed by compacting flag
    expect(deps.generateText).toHaveBeenCalledTimes(1);

    // Complete the compaction
    resolveGenerate(genSuccess('Summary'));
    await flushMicrotasks();

    // Now a small step that brings us back over threshold should trigger
    // again. If the fix is wrong (resets to 0), we'd need the full
    // threshold again. With the fix, only `threshold - inflightTokens`
    // more tokens are needed.
    vi.mocked(deps.generateText)!.mockClear();
    vi.mocked(deps.generateText)!.mockResolvedValue(genSuccess('Summary2'));

    // Add just 1 token — total is now inflightTokens + 1, still below
    // threshold, so no compaction yet.
    await ext.onStepComplete!(makeResult(makeUsage(1, 0)));
    await flushMicrotasks();
    expect(deps.generateText).not.toHaveBeenCalled();

    // Add enough to exceed threshold: remaining = threshold - inflightTokens - 1
    const remaining = FALLBACK_COMPACTION_THRESHOLD - inflightTokens - 1;
    await ext.onStepComplete!(makeResult(makeUsage(remaining, 0)));
    await flushMicrotasks();

    expect(deps.generateText).toHaveBeenCalledTimes(1);
  });
});

describe('ContextCompactionExt — compaction trigger', () => {
  it('triggers compaction when accumulated tokens exceed threshold', async () => {
    const deps = makeDeps({
      getHistory: vi.fn(() => [
        makeSummaryMessage('old summary'),
        makeTextMessage('user', 'Hello'),
        makeTextMessage('assistant', 'Hi there'),
      ]),
      generateText: vi.fn().mockResolvedValue(genSuccess('New summary')),
    });

    const ext = createContextCompactionExt.create(deps);
    await ext.onStepComplete!(
      makeResult(makeUsage(FALLBACK_COMPACTION_THRESHOLD, 0)),
    );
    await flushMicrotasks();

    expect(deps.generateText).toHaveBeenCalledTimes(1);
  });

  it('does not trigger concurrent compaction', async () => {
    const deps = makeDeps({
      getHistory: vi.fn(() => [
        makeTextMessage('user', 'Hello'),
        makeTextMessage('assistant', 'Hi there'),
      ]),
    });

    // Make generateText slow so compaction stays in flight
    let resolveGenerate!: (
      v: ReturnType<typeof genSuccess> | ReturnType<typeof genFailure>,
    ) => void;
    vi.mocked(deps.generateText)!.mockReturnValue(
      new Promise((resolve) => {
        resolveGenerate = resolve;
      }) as never,
    );

    const ext = createContextCompactionExt.create(deps);
    await ext.onStepComplete!(
      makeResult(makeUsage(FALLBACK_COMPACTION_THRESHOLD, 0)),
    );
    await flushMicrotasks();

    // Second call while first compaction is in-flight
    await ext.onStepComplete!(
      makeResult(makeUsage(FALLBACK_COMPACTION_THRESHOLD, 0)),
    );
    await flushMicrotasks();

    // Only one generateText call — second was suppressed
    expect(deps.generateText).toHaveBeenCalledTimes(1);

    // Release the pending compaction
    resolveGenerate(genSuccess('Summary'));
    await flushMicrotasks();
  });

  it('resets accumulated tokens after compaction completes', async () => {
    const deps = makeDeps({
      getHistory: vi.fn(() => [
        makeTextMessage('user', 'Hello'),
        makeTextMessage('assistant', 'Hi there'),
      ]),
      generateText: vi.fn().mockResolvedValue(genSuccess('New summary')),
    });

    const ext = createContextCompactionExt.create(deps);
    await ext.onStepComplete!(
      makeResult(makeUsage(FALLBACK_COMPACTION_THRESHOLD, 0)),
    );
    await flushMicrotasks();

    // After compaction completes, another small step should NOT trigger
    vi.mocked(deps.generateText)!.mockClear();
    await ext.onStepComplete!(makeResult(makeUsage(100, 50)));
    await flushMicrotasks();

    expect(deps.generateText).not.toHaveBeenCalled();
  });
});

describe('ContextCompactionExt — runCompaction', () => {
  it('calls generateText with compaction model IDs and system prompt', async () => {
    const deps = makeDeps({
      getHistory: vi.fn(() => [
        makeTextMessage('user', 'Hello'),
        makeTextMessage('assistant', 'Hi'),
      ]),
      generateText: vi.fn().mockResolvedValue(genSuccess('Summary text')),
    });

    const ext = createContextCompactionExt.create(deps);
    await ext.onStepComplete!(
      makeResult(makeUsage(FALLBACK_COMPACTION_THRESHOLD, 0)),
    );
    await flushMicrotasks();

    expect(deps.generateText).toHaveBeenCalledTimes(1);
    const args = vi.mocked(deps.generateText)!.mock.calls[0]![0];
    expect(args.modelIds).toEqual(['remote:gpt-4o']);
    expect(args.system).toBe(
      'You are a summarizer. Summarize the conversation.',
    );
    expect(args.prompt).toContain('<msg role="user">');
  });

  it('delegates model fallback to the session proxy', async () => {
    const deps = makeDeps({
      getHistory: vi.fn(() => [
        makeTextMessage('user', 'Hello'),
        makeTextMessage('assistant', 'Hi'),
      ]),
      config: {
        getModelSelection: vi.fn(() => ['remote:gpt-4o', 'remote:claude']),
        getModelContextSize: vi.fn(() => 20_000),
      } as unknown as ExtensionDeps['config'],
      generateText: vi
        .fn()
        .mockResolvedValue(genSuccess('Summary from fallback')),
    });

    const ext = createContextCompactionExt.create(deps);
    await ext.onStepComplete!(
      makeResult(makeUsage(FALLBACK_COMPACTION_THRESHOLD, 0)),
    );
    await flushMicrotasks();

    // The extension delegates to the proxy once — per-model retry is
    // handled inside the session's generateText.
    expect(deps.generateText).toHaveBeenCalledTimes(1);
    const args = vi.mocked(deps.generateText)!.mock.calls[0]![0];
    expect(args.modelIds).toEqual(['remote:gpt-4o', 'remote:claude']);
    expect(deps.insertMessageAfter).toHaveBeenCalledTimes(1);
  });

  it('inserts summary via insertMessageAfter (not inbox)', async () => {
    const history = [
      makeTextMessage('user', 'Hello'),
      makeTextMessage('assistant', 'Hi'),
    ];
    const deps = makeDeps({
      getHistory: vi.fn(() => history),
      generateText: vi.fn().mockResolvedValue(genSuccess('Compressed summary')),
    });

    const ext = createContextCompactionExt.create(deps);
    await ext.onStepComplete!(
      makeResult(makeUsage(FALLBACK_COMPACTION_THRESHOLD, 0)),
    );
    await flushMicrotasks();

    expect(deps.insertMessageAfter).toHaveBeenCalledTimes(1);
    expect(deps.inbox.sendMessage).not.toHaveBeenCalled();
    const [anchorId, message] = vi.mocked(deps.insertMessageAfter)!.mock
      .calls[0]!;
    // Anchor is the ID of the last message in the compaction slice
    expect(anchorId).toBe(history[1]!.id);
    expect(message.parts[0]).toMatchObject({
      type: 'data-context-summary',
      data: { summary: 'Compressed summary' },
    });
  });

  it('summary message has assistant role and data-context-summary part', async () => {
    const deps = makeDeps({
      getHistory: vi.fn(() => [
        makeTextMessage('user', 'Hello'),
        makeTextMessage('assistant', 'Hi'),
      ]),
      generateText: vi
        .fn()
        .mockResolvedValue(
          genSuccess('The user said hello and the assistant greeted them.'),
        ),
    });

    const ext = createContextCompactionExt.create(deps);
    await ext.onStepComplete!(
      makeResult(makeUsage(FALLBACK_COMPACTION_THRESHOLD, 0)),
    );
    await flushMicrotasks();

    const [, message] = vi.mocked(deps.insertMessageAfter)!.mock.calls[0]!;
    expect(message.role).toBe('assistant');
    expect(message.parts).toHaveLength(1);
    expect(message.parts[0]).toMatchObject({
      type: 'data-context-summary',
      data: { summary: 'The user said hello and the assistant greeted them.' },
    });
    expect(typeof message.id).toBe('string');
  });

  it('skips when no compaction or chat models configured', async () => {
    const deps = makeDeps({
      getHistory: vi.fn(() => [
        makeTextMessage('user', 'Hello'),
        makeTextMessage('assistant', 'Hi'),
      ]),
      config: {
        getModelSelection: vi.fn(() => []),
        getModelContextSize: vi.fn(() => 20_000),
      } as unknown as ExtensionDeps['config'],
    });

    const ext = createContextCompactionExt.create(deps);
    await ext.onStepComplete!(
      makeResult(makeUsage(FALLBACK_COMPACTION_THRESHOLD, 0)),
    );
    await flushMicrotasks();

    expect(deps.generateText).not.toHaveBeenCalled();
    expect(deps.insertMessageAfter).not.toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalled();
  });

  it('falls back to chat models when no compaction models configured', async () => {
    const getModelSelection = vi.fn((key: string) => {
      if (key === 'compaction') return [];
      return ['remote:gpt-4o'];
    });
    const deps = makeDeps({
      getHistory: vi.fn(() => [
        makeTextMessage('user', 'Hello'),
        makeTextMessage('assistant', 'Hi'),
      ]),
      config: {
        getModelSelection,
        getModelContextSize: vi.fn(() => 20_000),
      } as unknown as ExtensionDeps['config'],
      generateText: vi.fn().mockResolvedValue(genSuccess('Chat model summary')),
    });

    const ext = createContextCompactionExt.create(deps);
    await ext.onStepComplete!(
      makeResult(makeUsage(FALLBACK_COMPACTION_THRESHOLD, 0)),
    );
    await flushMicrotasks();

    expect(getModelSelection).toHaveBeenCalledWith('compaction');
    expect(getModelSelection).toHaveBeenCalledWith('chat');
    expect(deps.generateText).toHaveBeenCalledTimes(1);
    const args = vi.mocked(deps.generateText)!.mock.calls[0]![0];
    expect(args.modelIds).toEqual(['remote:gpt-4o']);
    expect(deps.insertMessageAfter).toHaveBeenCalledTimes(1);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      'No compaction models configured — falling back to chat models',
    );
  });

  it('skips when history is empty after last summary', async () => {
    const deps = makeDeps({
      getHistory: vi.fn(() => [makeSummaryMessage('existing summary')]),
    });

    const ext = createContextCompactionExt.create(deps);
    await ext.onStepComplete!(
      makeResult(makeUsage(FALLBACK_COMPACTION_THRESHOLD, 0)),
    );
    await flushMicrotasks();

    expect(deps.generateText).not.toHaveBeenCalled();
    expect(deps.insertMessageAfter).not.toHaveBeenCalled();
  });

  it('compactes even with a single new message after last summary', async () => {
    const deps = makeDeps({
      getHistory: vi.fn(() => [
        makeSummaryMessage('old summary'),
        makeTextMessage('user', 'Only one message'),
      ]),
      generateText: vi
        .fn()
        .mockResolvedValue(genSuccess('Summary of single message')),
    });

    const ext = createContextCompactionExt.create(deps);
    await ext.onStepComplete!(
      makeResult(makeUsage(FALLBACK_COMPACTION_THRESHOLD, 0)),
    );
    await flushMicrotasks();

    expect(deps.generateText).toHaveBeenCalledTimes(1);
    expect(deps.insertMessageAfter).toHaveBeenCalledTimes(1);
  });

  it('falls back to chat models when all compaction models fail', async () => {
    const getModelSelection = vi.fn((key: string) => {
      if (key === 'compaction') return ['remote:gpt-4o', 'remote:claude'];
      return ['remote:gemini'];
    });
    const deps = makeDeps({
      getHistory: vi.fn(() => [
        makeTextMessage('user', 'Hello'),
        makeTextMessage('assistant', 'Hi'),
      ]),
      config: {
        getModelSelection,
        getModelContextSize: vi.fn(() => 20_000),
      } as unknown as ExtensionDeps['config'],
    });

    // First call (compaction models) returns null — all failed.
    // Second call (chat models) returns a summary.
    vi.mocked(deps.generateText)!
      .mockResolvedValueOnce(genFailure())
      .mockResolvedValueOnce(genSuccess('Chat fallback summary'));

    const ext = createContextCompactionExt.create(deps);
    await ext.onStepComplete!(
      makeResult(makeUsage(FALLBACK_COMPACTION_THRESHOLD, 0)),
    );
    await flushMicrotasks();

    expect(deps.generateText).toHaveBeenCalledTimes(2);
    expect(deps.insertMessageAfter).toHaveBeenCalledTimes(1);
    const [, message] = vi.mocked(deps.insertMessageAfter)!.mock.calls[0]!;
    expect(message.parts[0]).toMatchObject({
      type: 'data-context-summary',
      data: { summary: 'Chat fallback summary' },
    });
  });

  it('does not throw when all compaction and chat models fail', async () => {
    const deps = makeDeps({
      getHistory: vi.fn(() => [
        makeTextMessage('user', 'Hello'),
        makeTextMessage('assistant', 'Hi'),
      ]),
      config: {
        getModelSelection: vi.fn(() => ['remote:gpt-4o']),
        getModelContextSize: vi.fn(() => 20_000),
      } as unknown as ExtensionDeps['config'],
      generateText: vi.fn().mockResolvedValue(genFailure()),
    });

    const ext = createContextCompactionExt.create(deps);
    await ext.onStepComplete!(
      makeResult(makeUsage(FALLBACK_COMPACTION_THRESHOLD, 0)),
    );
    await flushMicrotasks();

    // generateText was called for compaction models, then
    // again for chat models — both returned null.
    expect(deps.generateText).toHaveBeenCalledTimes(2);
    expect(deps.insertMessageAfter).not.toHaveBeenCalled();
  });

  it('inserts summary after the last message of the compaction slice', async () => {
    const history = [
      makeTextMessage('user', 'Old message 1'),
      makeTextMessage('assistant', 'Old response 1'),
      makeSummaryMessage('Previous summary'),
      makeTextMessage('user', 'New message'),
      makeTextMessage('assistant', 'New response'),
    ];
    const deps = makeDeps({
      getHistory: vi.fn(() => history),
      generateText: vi
        .fn()
        .mockResolvedValue(genSuccess('Summary of new messages')),
    });

    const ext = createContextCompactionExt.create(deps);
    await ext.onStepComplete!(
      makeResult(makeUsage(FALLBACK_COMPACTION_THRESHOLD, 0)),
    );
    await flushMicrotasks();

    // The anchor ID should be the last message in the slice
    const [anchorId] = vi.mocked(deps.insertMessageAfter)!.mock.calls[0]!;
    expect(anchorId).toBe(history[4]!.id);
  });

  it('does not throw when anchor message no longer exists', async () => {
    const deps = makeDeps({
      getHistory: vi.fn(() => [
        makeTextMessage('user', 'Hello'),
        makeTextMessage('assistant', 'Hi'),
      ]),
      insertMessageAfter: vi.fn(() => false),
      generateText: vi.fn().mockResolvedValue(genSuccess('Summary')),
    });

    const ext = createContextCompactionExt.create(deps);
    await ext.onStepComplete!(
      makeResult(makeUsage(FALLBACK_COMPACTION_THRESHOLD, 0)),
    );
    await flushMicrotasks();

    expect(deps.insertMessageAfter).toHaveBeenCalledTimes(1);
    expect(deps.logger.warn).toHaveBeenCalled();
  });
});

describe('ContextCompactionExt — compacting flag safety', () => {
  it('resets compacting flag and allows re-trigger after successful compaction', async () => {
    const deps = makeDeps({
      getHistory: vi.fn(() => [
        makeTextMessage('user', 'Hello'),
        makeTextMessage('assistant', 'Hi'),
      ]),
      generateText: vi.fn().mockResolvedValue(genSuccess('Summary')),
    });

    const ext = createContextCompactionExt.create(deps);

    await ext.onStepComplete!(
      makeResult(makeUsage(FALLBACK_COMPACTION_THRESHOLD, 0)),
    );
    await flushMicrotasks();

    // Second step should trigger compaction again because the flag
    // was reset and accumulated tokens were zeroed on success.
    await ext.onStepComplete!(
      makeResult(makeUsage(FALLBACK_COMPACTION_THRESHOLD, 0)),
    );
    await flushMicrotasks();

    expect(deps.generateText).toHaveBeenCalledTimes(2);
    expect(deps.insertMessageAfter).toHaveBeenCalledTimes(2);
  });

  it('logs error and resets compacting flag when runCompactionInner throws', async () => {
    const deps = makeDeps({
      getHistory: vi.fn(() => {
        throw new Error('history access failed');
      }),
    });

    const ext = createContextCompactionExt.create(deps);

    await ext.onStepComplete!(
      makeResult(makeUsage(FALLBACK_COMPACTION_THRESHOLD, 0)),
    );
    await flushMicrotasks();

    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(Error) }),
      'Compaction failed with unexpected error',
    );

    // Verify compacting flag was reset by triggering another compaction
    // with a working getHistory.
    deps.getHistory = vi.fn(() => [
      makeTextMessage('user', 'Hello'),
      makeTextMessage('assistant', 'Hi'),
    ]);
    vi.mocked(deps.generateText)!.mockResolvedValue(genSuccess('Summary'));
    await ext.onStepComplete!(
      makeResult(makeUsage(FALLBACK_COMPACTION_THRESHOLD, 0)),
    );
    await flushMicrotasks();

    expect(deps.generateText).toHaveBeenCalledTimes(1);
    expect(deps.insertMessageAfter).toHaveBeenCalledTimes(1);
  });

  it('does not reset accumulated tokens on failed compaction', async () => {
    const deps = makeDeps({
      getHistory: vi.fn(() => [
        makeTextMessage('user', 'Hello'),
        makeTextMessage('assistant', 'Hi'),
      ]),
      // All models fail — proxy returns null
      generateText: vi.fn().mockResolvedValue(genFailure()),
    });

    const ext = createContextCompactionExt.create(deps);

    await ext.onStepComplete!(
      makeResult(makeUsage(FALLBACK_COMPACTION_THRESHOLD, 0)),
    );
    await flushMicrotasks();

    expect(deps.insertMessageAfter).not.toHaveBeenCalled();

    // Second trigger with just 1 new token — should still fire because
    // accumulated tokens were NOT reset after the failure.
    vi.mocked(deps.generateText)!.mockResolvedValue(genSuccess('Summary'));
    await ext.onStepComplete!(makeResult(makeUsage(1, 0)));
    await flushMicrotasks();

    expect(deps.insertMessageAfter).toHaveBeenCalledTimes(1);
  });
});

describe('ContextCompactionExt — threshold computation', () => {
  it('computes dynamic threshold as 50% of the smallest context size', async () => {
    const ctxSize = 30_000;
    const expectedThreshold = Math.floor(
      ctxSize * CONTEXT_SIZE_THRESHOLD_RATIO,
    );
    const deps = makeDeps({
      config: {
        getModelSelection: vi.fn(() => ['remote:gpt-4o']),
        getModelContextSize: vi.fn(() => ctxSize),
      } as unknown as ExtensionDeps['config'],
      getHistory: vi.fn(() => [
        makeTextMessage('user', 'Hello'),
        makeTextMessage('assistant', 'Hi'),
      ]),
      generateText: vi.fn().mockResolvedValue(genSuccess('Summary')),
    });

    const ext = createContextCompactionExt.create(deps);

    // Just below threshold — no compaction
    await ext.onStepComplete!(makeResult(makeUsage(expectedThreshold - 1, 0)));
    await flushMicrotasks();
    expect(deps.generateText).not.toHaveBeenCalled();

    // At threshold — compaction triggers
    await ext.onStepComplete!(makeResult(makeUsage(1, 0)));
    await flushMicrotasks();
    expect(deps.generateText).toHaveBeenCalledTimes(1);
  });

  it('uses the smallest context size among configured chat models only', async () => {
    const getModelSelection = vi.fn((key: string) => {
      if (key === 'chat') return ['remote:gpt-4o', 'remote:gemini'];
      return ['remote:claude'];
    });
    const getModelContextSize = vi.fn((modelId: string) => {
      if (modelId === 'remote:gpt-4o') return 60_000;
      if (modelId === 'remote:gemini') return 40_000; // smallest chat model
      return 20_000; // compaction model — should be ignored
    });
    const deps = makeDeps({
      config: {
        getModelSelection,
        getModelContextSize,
      } as unknown as ExtensionDeps['config'],
      getHistory: vi.fn(() => [
        makeTextMessage('user', 'Hello'),
        makeTextMessage('assistant', 'Hi'),
      ]),
      generateText: vi.fn().mockResolvedValue(genSuccess('Summary')),
    });

    const ext = createContextCompactionExt.create(deps);

    // Threshold = min(40_000 * 0.5, 200_000) = 20_000
    // If it incorrectly included compaction models: threshold would be 10_000
    // If it used the max chat model: threshold would be 30_000
    await ext.onStepComplete!(makeResult(makeUsage(19_999, 0)));
    await flushMicrotasks();
    expect(deps.generateText).not.toHaveBeenCalled();

    await ext.onStepComplete!(makeResult(makeUsage(1, 0)));
    await flushMicrotasks();
    expect(deps.generateText).toHaveBeenCalledTimes(1);
  });

  it('caps threshold at MAX_COMPACTION_THRESHOLD', async () => {
    const hugeCtxSize = MAX_COMPACTION_THRESHOLD * 4; // 800k → 50% = 400k, capped to 200k
    const deps = makeDeps({
      config: {
        getModelSelection: vi.fn(() => ['remote:gpt-4o']),
        getModelContextSize: vi.fn(() => hugeCtxSize),
      } as unknown as ExtensionDeps['config'],
      getHistory: vi.fn(() => [
        makeTextMessage('user', 'Hello'),
        makeTextMessage('assistant', 'Hi'),
      ]),
      generateText: vi.fn().mockResolvedValue(genSuccess('Summary')),
    });

    const ext = createContextCompactionExt.create(deps);

    // At the cap — compaction triggers
    await ext.onStepComplete!(
      makeResult(makeUsage(MAX_COMPACTION_THRESHOLD, 0)),
    );
    await flushMicrotasks();
    expect(deps.generateText).toHaveBeenCalledTimes(1);
  });

  it('caches the threshold for the extension lifetime', async () => {
    const getModelContextSize = vi.fn(() => 30_000);
    const deps = makeDeps({
      config: {
        getModelSelection: vi.fn(() => ['remote:gpt-4o']),
        getModelContextSize,
      } as unknown as ExtensionDeps['config'],
      getHistory: vi.fn(() => [
        makeTextMessage('user', 'Hello'),
        makeTextMessage('assistant', 'Hi'),
      ]),
      generateText: vi.fn().mockResolvedValue(genSuccess('Summary')),
    });

    const ext = createContextCompactionExt.create(deps);

    // First call computes the threshold
    await ext.onStepComplete!(
      makeResult(makeUsage(15_000, 0)), // 30_000 * 0.5 = 15_000
    );
    await flushMicrotasks();
    expect(getModelContextSize).toHaveBeenCalled();

    // Reset mock and trigger again — threshold should be cached
    getModelContextSize.mockClear();
    vi.mocked(deps.generateText)!.mockClear();
    await ext.onStepComplete!(makeResult(makeUsage(15_000, 0)));
    await flushMicrotasks();

    // getModelContextSize should NOT have been called again
    expect(getModelContextSize).not.toHaveBeenCalled();
  });

  it('skips models whose context size cannot be resolved', async () => {
    const getModelSelection = vi.fn(() => ['remote:gpt-4o', 'remote:claude']);
    const getModelContextSize = vi.fn((modelId: string) => {
      if (modelId === 'remote:gpt-4o') throw new Error('unknown model');
      return 30_000; // claude resolves fine
    });
    const deps = makeDeps({
      config: {
        getModelSelection,
        getModelContextSize,
      } as unknown as ExtensionDeps['config'],
      getHistory: vi.fn(() => [
        makeTextMessage('user', 'Hello'),
        makeTextMessage('assistant', 'Hi'),
      ]),
      generateText: vi.fn().mockResolvedValue(genSuccess('Summary')),
    });

    const ext = createContextCompactionExt.create(deps);

    // gpt-4o throws, claude returns 30_000
    // Threshold = min(30_000 * 0.5, 200_000) = 15_000
    await ext.onStepComplete!(makeResult(makeUsage(15_000, 0)));
    await flushMicrotasks();
    expect(deps.generateText).toHaveBeenCalledTimes(1);
  });

  it('falls back to FALLBACK_COMPACTION_THRESHOLD when all context sizes fail', async () => {
    const deps = makeDeps({
      config: {
        getModelSelection: vi.fn(() => ['remote:gpt-4o']),
        getModelContextSize: vi.fn(() => {
          throw new Error('resolution failed');
        }),
      } as unknown as ExtensionDeps['config'],
      getHistory: vi.fn(() => [
        makeTextMessage('user', 'Hello'),
        makeTextMessage('assistant', 'Hi'),
      ]),
      generateText: vi.fn().mockResolvedValue(genSuccess('Summary')),
    });

    const ext = createContextCompactionExt.create(deps);

    await ext.onStepComplete!(
      makeResult(makeUsage(FALLBACK_COMPACTION_THRESHOLD, 0)),
    );
    await flushMicrotasks();
    expect(deps.generateText).toHaveBeenCalledTimes(1);
  });

  it('skips compaction when no models are configured despite threshold fallback', async () => {
    const deps = makeDeps({
      config: {
        getModelSelection: vi.fn(() => []),
        getModelContextSize: vi.fn(() => 20_000),
      } as unknown as ExtensionDeps['config'],
      getHistory: vi.fn(() => [
        makeTextMessage('user', 'Hello'),
        makeTextMessage('assistant', 'Hi'),
      ]),
    });

    const ext = createContextCompactionExt.create(deps);

    await ext.onStepComplete!(
      makeResult(makeUsage(FALLBACK_COMPACTION_THRESHOLD, 0)),
    );
    await flushMicrotasks();
    // Threshold falls back to FALLBACK_COMPACTION_THRESHOLD, so
    // compaction is triggered, but runCompactionInner skips because
    // no models are configured.
    expect(deps.generateText).not.toHaveBeenCalled();
    expect(deps.insertMessageAfter).not.toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalledWith(
      'No compaction or chat models configured — skipping',
    );
  });
});

describe('ContextCompactionExt — history transformation', () => {
  it('wraps text parts in <text> tags inside <msg> elements', async () => {
    const deps = makeDeps({
      getHistory: vi.fn(() => [
        makeTextMessage('user', 'Hello world'),
        makeTextMessage('assistant', 'Hi there'),
      ]),
      generateText: vi.fn().mockResolvedValue(genSuccess('Summary')),
    });

    const ext = createContextCompactionExt.create(deps);
    await ext.onStepComplete!(
      makeResult(makeUsage(FALLBACK_COMPACTION_THRESHOLD, 0)),
    );
    await flushMicrotasks();

    const prompt = vi.mocked(deps.generateText)!.mock.calls[0]![0]
      .prompt as string;
    expect(prompt).toContain('<msg role="user"><text>Hello world</text></msg>');
    expect(prompt).toContain(
      '<msg role="assistant"><text>Hi there</text></msg>',
    );
  });

  it('truncates long text parts with … inside <text> tags', async () => {
    const longText = 'x'.repeat(600);
    const deps = makeDeps({
      getHistory: vi.fn(() => [
        makeTextMessage('user', longText),
        makeTextMessage('assistant', 'OK'),
      ]),
      generateText: vi.fn().mockResolvedValue(genSuccess('Summary')),
    });

    const ext = createContextCompactionExt.create(deps);
    await ext.onStepComplete!(
      makeResult(makeUsage(FALLBACK_COMPACTION_THRESHOLD, 0)),
    );
    await flushMicrotasks();

    const prompt = vi.mocked(deps.generateText)!.mock.calls[0]![0]
      .prompt as string;
    const line = prompt.split('\n')[0]!;
    expect(line).toContain('<text>');
    expect(line).toContain('…');
    expect(line).toContain('</text>');
    expect(line.length).toBeLessThan(longText.length);
  });

  it('uses <tool name="..."> for tool calls (input omitted)', async () => {
    const deps = makeDeps({
      getHistory: vi.fn(() => [
        makeToolCallMessage('readFile', { path: '/foo.ts' }),
        makeTextMessage('assistant', 'OK'),
      ]),
      generateText: vi.fn().mockResolvedValue(genSuccess('Summary')),
    });

    const ext = createContextCompactionExt.create(deps);
    await ext.onStepComplete!(
      makeResult(makeUsage(FALLBACK_COMPACTION_THRESHOLD, 0)),
    );
    await flushMicrotasks();

    const prompt = vi.mocked(deps.generateText)!.mock.calls[0]![0]
      .prompt as string;
    expect(prompt).toContain('<tool name="readFile" />');
    // Tool input should NOT be included in the XML output
    expect(prompt).not.toContain('/foo.ts');
  });

  it('includes tool output in <output> tag when output-available', async () => {
    const deps = makeDeps({
      getHistory: vi.fn(() => [
        makeToolCallMessage(
          'readFile',
          { path: '/foo.ts' },
          'file contents here',
        ),
        makeTextMessage('assistant', 'OK'),
      ]),
      generateText: vi.fn().mockResolvedValue(genSuccess('Summary')),
    });

    const ext = createContextCompactionExt.create(deps);
    await ext.onStepComplete!(
      makeResult(makeUsage(FALLBACK_COMPACTION_THRESHOLD, 0)),
    );
    await flushMicrotasks();

    const prompt = vi.mocked(deps.generateText)!.mock.calls[0]![0]
      .prompt as string;
    expect(prompt).toContain(
      '<tool name="readFile"><output>file contents here</output></tool>',
    );
  });

  it('uses <error> tag for error tool outputs', async () => {
    const deps = makeDeps({
      getHistory: vi.fn(() => [
        makeToolCallMessage(
          'readFile',
          { path: '/foo.ts' },
          undefined,
          'output-error',
          'File not found',
        ),
        makeTextMessage('assistant', 'OK'),
      ]),
      generateText: vi.fn().mockResolvedValue(genSuccess('Summary')),
    });

    const ext = createContextCompactionExt.create(deps);
    await ext.onStepComplete!(
      makeResult(makeUsage(FALLBACK_COMPACTION_THRESHOLD, 0)),
    );
    await flushMicrotasks();

    const prompt = vi.mocked(deps.generateText)!.mock.calls[0]![0]
      .prompt as string;
    expect(prompt).toContain(
      '<tool name="readFile"><error>File not found</error></tool>',
    );
  });

  it('uses <ctx env="..."> tag for context parts', async () => {
    const deps = makeDeps({
      getHistory: vi.fn(() => [
        makeContextMessage('browser', 'Page title: Example'),
        makeTextMessage('assistant', 'OK'),
      ]),
      generateText: vi.fn().mockResolvedValue(genSuccess('Summary')),
    });

    const ext = createContextCompactionExt.create(deps);
    await ext.onStepComplete!(
      makeResult(makeUsage(FALLBACK_COMPACTION_THRESHOLD, 0)),
    );
    await flushMicrotasks();

    const prompt = vi.mocked(deps.generateText)!.mock.calls[0]![0]
      .prompt as string;
    expect(prompt).toContain(
      '<ctx env="browser"><text>Page title: Example</text></ctx>',
    );
  });

  it('packs multiple parts inside a single <msg> tag', async () => {
    const msg: ExtendedUIMessage = {
      id: randomUUID(),
      role: 'assistant',
      parts: [
        { type: 'text', text: 'Let me check' },
        {
          type: 'tool',
          toolCallId: 'tc1',
          toolName: 'search',
          input: { q: 'test' },
          state: 'output-available',
          output: 'result data',
        } as never,
      ],
    } as ExtendedUIMessage;

    const deps = makeDeps({
      getHistory: vi.fn(() => [msg, makeTextMessage('assistant', 'done')]),
      generateText: vi.fn().mockResolvedValue(genSuccess('Summary')),
    });

    const ext = createContextCompactionExt.create(deps);
    await ext.onStepComplete!(
      makeResult(makeUsage(FALLBACK_COMPACTION_THRESHOLD, 0)),
    );
    await flushMicrotasks();

    const prompt = vi.mocked(deps.generateText)!.mock.calls[0]![0]
      .prompt as string;
    const firstLine = prompt.split('\n')[0]!;
    expect(firstLine).toContain('<msg role="assistant">');
    expect(firstLine).toContain('<text>Let me check</text>');
    expect(firstLine).toContain(
      '<tool name="search"><output>result data</output></tool>',
    );
    expect(firstLine).toContain('</msg>');
  });

  it('includes previous summary in <summary> tag and excludes data-continue parts', async () => {
    const msg: ExtendedUIMessage = {
      id: randomUUID(),
      role: 'user',
      parts: [
        { type: 'data-continue', data: {} } as never,
        { type: 'text', text: 'actual text' },
      ],
    } as ExtendedUIMessage;

    const deps = makeDeps({
      getHistory: vi.fn(() => [
        makeSummaryMessage('old summary text'),
        msg,
        makeTextMessage('assistant', 'response'),
      ]),
      generateText: vi.fn().mockResolvedValue(genSuccess('Summary')),
    });

    const ext = createContextCompactionExt.create(deps);
    await ext.onStepComplete!(
      makeResult(makeUsage(FALLBACK_COMPACTION_THRESHOLD, 0)),
    );
    await flushMicrotasks();

    const prompt = vi.mocked(deps.generateText)!.mock.calls[0]![0]
      .prompt as string;
    expect(prompt).toContain('actual text');
    // Previous summary should be included in a <summary> tag
    expect(prompt).toContain('<summary>old summary text</summary>');
    // data-continue should not produce any output
    expect(prompt).not.toContain('Continue');
  });

  it('escapes XML special characters in text content', async () => {
    const deps = makeDeps({
      getHistory: vi.fn(() => [
        makeTextMessage('user', 'a < b & c > d "e" \'f\''),
        makeTextMessage('assistant', 'OK'),
      ]),
      generateText: vi.fn().mockResolvedValue(genSuccess('Summary')),
    });

    const ext = createContextCompactionExt.create(deps);
    await ext.onStepComplete!(
      makeResult(makeUsage(FALLBACK_COMPACTION_THRESHOLD, 0)),
    );
    await flushMicrotasks();

    const prompt = vi.mocked(deps.generateText)!.mock.calls[0]![0]
      .prompt as string;
    expect(prompt).toContain(
      'a &lt; b &amp; c &gt; d &quot;e&quot; &apos;f&apos;',
    );
  });

  it('uses <denied /> for output-denied tool state', async () => {
    const deps = makeDeps({
      getHistory: vi.fn(() => [
        makeToolCallMessage(
          'readFile',
          { path: '/foo.ts' },
          undefined,
          'output-denied',
        ),
        makeTextMessage('assistant', 'OK'),
      ]),
      generateText: vi.fn().mockResolvedValue(genSuccess('Summary')),
    });

    const ext = createContextCompactionExt.create(deps);
    await ext.onStepComplete!(
      makeResult(makeUsage(FALLBACK_COMPACTION_THRESHOLD, 0)),
    );
    await flushMicrotasks();

    const prompt = vi.mocked(deps.generateText)!.mock.calls[0]![0]
      .prompt as string;
    expect(prompt).toContain('<tool name="readFile"><denied /></tool>');
  });

  it('serializes object tool output as compact JSON', async () => {
    const deps = makeDeps({
      getHistory: vi.fn(() => [
        makeToolCallMessage(
          'readFile',
          { path: '/foo.ts' },
          {
            lines: 42,
            lang: 'ts',
          },
        ),
        makeTextMessage('assistant', 'OK'),
      ]),
      generateText: vi.fn().mockResolvedValue(genSuccess('Summary')),
    });

    const ext = createContextCompactionExt.create(deps);
    await ext.onStepComplete!(
      makeResult(makeUsage(FALLBACK_COMPACTION_THRESHOLD, 0)),
    );
    await flushMicrotasks();

    const prompt = vi.mocked(deps.generateText)!.mock.calls[0]![0]
      .prompt as string;
    expect(prompt).toContain('&quot;lines&quot;:42');
  });
});

describe('ContextCompactionExt — historyTransformer', () => {
  it('slices from last summary when enough messages follow it', () => {
    const history = [
      makeTextMessage('user', 'old1'),
      makeSummaryMessage('previous summary'),
      makeTextMessage('user', 'new1'),
      makeTextMessage('assistant', 'new2'),
      makeTextMessage('user', 'new3'),
    ];

    const ext = createContextCompactionExt.create(makeDeps());
    const result = ext.historyTransformer!(history);

    expect(Array.isArray(result)).toBe(false);
    const obj = result as {
      history: ExtendedUIMessage[];
      flags: { hasCompacted: boolean };
    };
    expect(obj.flags.hasCompacted).toBe(true);
    // Only 1 user message before the summary — kept as pre-summary context
    expect(obj.history[0]!.parts[0]).toMatchObject({
      type: 'text',
      text: 'old1',
    });
    // Summary is at index 1
    expect(obj.history[1]!.parts[0]).toMatchObject({
      type: 'data-context-summary',
    });
    expect(obj.history).toHaveLength(5); // old1 + summary + new1 + new2 + new3
  });

  it('returns full history when no summary exists', () => {
    const history = [
      makeTextMessage('user', 'msg1'),
      makeTextMessage('assistant', 'msg2'),
    ];

    const ext = createContextCompactionExt.create(makeDeps());
    const result = ext.historyTransformer!(history);

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
  });

  it('ignores a summary with too few messages after it and uses an older one', () => {
    const history = [
      makeTextMessage('user', 'old1'),
      makeSummaryMessage('older summary'),
      makeTextMessage('user', 'mid1'),
      makeTextMessage('assistant', 'mid2'),
      makeTextMessage('user', 'mid3'),
      makeSummaryMessage('newer summary'),
      makeTextMessage('user', 'recent1'),
      // only 1 message after newer summary — below threshold
    ];

    const ext = createContextCompactionExt.create(makeDeps());
    const result = ext.historyTransformer!(history);

    expect(Array.isArray(result)).toBe(false);
    const obj = result as {
      history: ExtendedUIMessage[];
      flags: { hasCompacted: boolean };
    };
    expect(obj.flags.hasCompacted).toBe(true);
    // Only 1 user message before the older summary — kept as pre-summary
    expect(obj.history[0]!.parts[0]).toMatchObject({
      type: 'text',
      text: 'old1',
    });
    // Summary is at index 1
    expect(obj.history[1]!.parts[0]).toMatchObject({
      type: 'data-context-summary',
      data: { summary: 'older summary' },
    });
    // old1 + older summary + mid1 + mid2 + mid3 + recent1 (newer summary stripped)
    expect(obj.history).toHaveLength(6);
    // The newer summary should be stripped (it's not the cutoff)
    expect(
      obj.history.some((m) =>
        m.parts.some(
          (p) =>
            p.type === 'data-context-summary' &&
            (p as { data: { summary: string } }).data.summary ===
              'newer summary',
        ),
      ),
    ).toBe(false);
  });

  it('marks hasCompacted when summaries exist but none has enough messages after it', () => {
    const history = [
      makeSummaryMessage('summary1'),
      makeSummaryMessage('summary2'),
    ];
    // summary1 has 1 message after it, summary2 has 0 — both below threshold

    const ext = createContextCompactionExt.create(makeDeps());
    const result = ext.historyTransformer!(history);

    expect(Array.isArray(result)).toBe(false);
    const obj = result as {
      history: ExtendedUIMessage[];
      flags: { hasCompacted: boolean };
    };
    expect(obj.flags.hasCompacted).toBe(true);
    expect(obj.history).toHaveLength(2);
  });

  it('strips extra summaries from the result, keeping only the cutoff', () => {
    const history = [
      makeTextMessage('user', 'old1'),
      makeSummaryMessage('old summary'),
      makeTextMessage('user', 'msg1'),
      makeTextMessage('assistant', 'msg2'),
      makeTextMessage('user', 'msg3'),
      makeSummaryMessage('mid summary'),
      makeTextMessage('user', 'msg4'),
      makeTextMessage('assistant', 'msg5'),
      makeTextMessage('user', 'msg6'),
    ];
    // old summary has 7 messages after it (>= 2) — it qualifies
    // mid summary has 3 messages after it (>= 2) — it's newer and also qualifies
    // The newest qualifying summary (mid summary) should be the cutoff

    const ext = createContextCompactionExt.create(makeDeps());
    const result = ext.historyTransformer!(history);

    expect(Array.isArray(result)).toBe(false);
    const obj = result as {
      history: ExtendedUIMessage[];
      flags: { hasCompacted: boolean };
    };
    // Pre-summary messages: walking back from mid summary (index 5),
    // skipping old summary: msg3 (user), msg2 (assistant), msg1 (user)
    // → 2 users + 1 assistant kept (only 1 assistant available before cutoff)
    expect(obj.history[0]!.parts[0]).toMatchObject({
      type: 'text',
      text: 'msg1',
    });
    expect(obj.history[1]!.parts[0]).toMatchObject({
      type: 'text',
      text: 'msg2',
    });
    expect(obj.history[2]!.parts[0]).toMatchObject({
      type: 'text',
      text: 'msg3',
    });
    // Cutoff summary at index 3
    expect(obj.history[3]!.parts[0]).toMatchObject({
      type: 'data-context-summary',
      data: { summary: 'mid summary' },
    });
    // Only one summary in the result
    const summaryCount = obj.history.filter((m) =>
      m.parts.some((p) => p.type === 'data-context-summary'),
    ).length;
    expect(summaryCount).toBe(1);
  });

  it('retains at least 2 user and 2 assistant messages before the cutoff summary', () => {
    const history = [
      makeTextMessage('user', 'u1'),
      makeTextMessage('assistant', 'a1'),
      makeTextMessage('user', 'u2'),
      makeTextMessage('assistant', 'a2'),
      makeTextMessage('user', 'u3'),
      makeSummaryMessage('summary'),
      makeTextMessage('user', 'new1'),
      makeTextMessage('assistant', 'new2'),
    ];

    const ext = createContextCompactionExt.create(makeDeps());
    const result = ext.historyTransformer!(history);

    const obj = result as {
      history: ExtendedUIMessage[];
      flags: { hasCompacted: boolean };
    };
    // The last 2 users (u2, u3) and last 2 assistants (a1, a2) before
    // the summary should be retained in chronological order.
    expect(obj.history[0]!.parts[0]).toMatchObject({
      type: 'text',
      text: 'a1',
    });
    expect(obj.history[1]!.parts[0]).toMatchObject({
      type: 'text',
      text: 'u2',
    });
    expect(obj.history[2]!.parts[0]).toMatchObject({
      type: 'text',
      text: 'a2',
    });
    expect(obj.history[3]!.parts[0]).toMatchObject({
      type: 'text',
      text: 'u3',
    });
    expect(obj.history[4]!.parts[0]).toMatchObject({
      type: 'data-context-summary',
    });
    expect(obj.history).toHaveLength(7); // a1, u2, a2, u3, summary, new1, new2
  });

  it('does not require a full 2+2 if fewer are available before the summary', () => {
    const history = [
      makeTextMessage('user', 'only-user'),
      makeSummaryMessage('summary'),
      makeTextMessage('user', 'new1'),
      makeTextMessage('assistant', 'new2'),
    ];

    const ext = createContextCompactionExt.create(makeDeps());
    const result = ext.historyTransformer!(history);

    const obj = result as {
      history: ExtendedUIMessage[];
      flags: { hasCompacted: boolean };
    };
    // Only 1 user message available before summary — kept as-is
    expect(obj.history[0]!.parts[0]).toMatchObject({
      type: 'text',
      text: 'only-user',
    });
    expect(obj.history[1]!.parts[0]).toMatchObject({
      type: 'data-context-summary',
    });
    expect(obj.history).toHaveLength(4); // only-user + summary + new1 + new2
  });

  it('skips other summary messages when collecting pre-summary context', () => {
    const history = [
      makeSummaryMessage('first summary'),
      makeTextMessage('user', 'u1'),
      makeTextMessage('assistant', 'a1'),
      makeTextMessage('user', 'u2'),
      makeTextMessage('assistant', 'a2'),
      makeSummaryMessage('second summary'),
      makeTextMessage('user', 'new1'),
      makeTextMessage('assistant', 'new2'),
    ];

    const ext = createContextCompactionExt.create(makeDeps());
    const result = ext.historyTransformer!(history);

    const obj = result as {
      history: ExtendedUIMessage[];
      flags: { hasCompacted: boolean };
    };
    // Cutoff is "second summary". Pre-summary messages walk back from
    // index 5, skipping "first summary": u2, a2, u1, a1 (2 users, 2 assistants).
    expect(obj.history[0]!.parts[0]).toMatchObject({
      type: 'text',
      text: 'u1',
    });
    expect(obj.history[1]!.parts[0]).toMatchObject({
      type: 'text',
      text: 'a1',
    });
    expect(obj.history[2]!.parts[0]).toMatchObject({
      type: 'text',
      text: 'u2',
    });
    expect(obj.history[3]!.parts[0]).toMatchObject({
      type: 'text',
      text: 'a2',
    });
    expect(obj.history[4]!.parts[0]).toMatchObject({
      type: 'data-context-summary',
      data: { summary: 'second summary' },
    });
    // Only one summary in the result
    const summaryCount = obj.history.filter((m) =>
      m.parts.some((p) => p.type === 'data-context-summary'),
    ).length;
    expect(summaryCount).toBe(1);
  });

  it('dataPartTransformers converts context-summary to <summary> text', () => {
    const ext = createContextCompactionExt.create(makeDeps());
    const transformer = ext.dataPartTransformers?.['context-summary'];
    expect(transformer).toBeDefined();

    const result = transformer!({ summary: 'test summary' } as never);
    expect(result).toEqual([
      { type: 'text', text: '<summary>test summary</summary>' },
    ]);
  });
});
