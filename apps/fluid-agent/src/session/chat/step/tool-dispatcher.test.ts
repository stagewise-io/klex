import { randomUUID } from 'node:crypto';

import type { Tool, ToolUIPart } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Re-import the mocked function so tests can assert it was called.
import { recordErrorOnSpan } from '@/tracing';

import type { ExtendedUIMessage } from '../message-types';
import { testLogger as logger } from '../test-helpers';
import type { AgentTools, AgentUITools } from '../tools';
import { ToolDispatcher } from './tool-dispatcher';

// --- mocks ---

vi.mock('@/tracing', () => ({
  recordErrorOnSpan: vi.fn(),
}));

vi.mock('../utils/tracing', () => ({
  startChildSpan: vi.fn(() => ({
    setAttribute: vi.fn(),
    setAttributes: vi.fn(),
    addEvent: vi.fn(),
    end: vi.fn(),
    recordException: vi.fn(),
    setStatus: vi.fn(),
  })),
  tracer: {
    startSpan: vi.fn(() => ({
      setAttribute: vi.fn(),
      end: vi.fn(),
      addEvent: vi.fn(),
    })),
  },
}));

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
    input: { query: 'test' },
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

function makeDispatcher(
  tools = {} as AgentTools,
  toolTimeoutMs?: number,
): ToolDispatcher {
  return new ToolDispatcher({
    logger,
    tools,
    modelMessages: [],
    toolTimeoutMs,
    sessionId: 'test-session-id',
  });
}

function makeTools(
  execute?: Tool['execute'],
  toolName = 'testTool',
): AgentTools {
  return {
    [toolName]: execute ? { execute } : {},
  } as unknown as AgentTools;
}

/** Cast a broad part to a tool part for field assertions after execution. */
function asToolPart(
  part: ExtendedUIMessage['parts'][number],
): ToolUIPart<AgentUITools> {
  return part as ToolUIPart<AgentUITools>;
}

// --- tests ---

describe('ToolDispatcher — at-most-once execution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('dispatches a tool call in input-available state', async () => {
    const execute = vi.fn().mockResolvedValue('result');
    const dispatcher = makeDispatcher(makeTools(execute));
    const part = makeToolPart('call-1');

    dispatcher.onUpdate(makeAssistantMessage([part]));
    await dispatcher.settle();

    expect(execute).toHaveBeenCalledOnce();
    expect(dispatcher.dispatchedCount).toBe(1);
    const toolPart = asToolPart(part);
    expect(toolPart.state).toBe('output-available');
    expect(toolPart.output).toBe('result');
  });

  it('does NOT dispatch the same tool call twice (same message)', async () => {
    const execute = vi.fn().mockResolvedValue('result');
    const dispatcher = makeDispatcher(makeTools(execute));
    const part = makeToolPart('call-1');
    const msg = makeAssistantMessage([part]);

    dispatcher.onUpdate(msg);
    dispatcher.onUpdate(msg);
    await dispatcher.settle();

    expect(execute).toHaveBeenCalledOnce();
    expect(dispatcher.dispatchedCount).toBe(1);
  });

  it('does NOT dispatch the same tool call twice (sweep after streaming)', async () => {
    const execute = vi.fn().mockResolvedValue('result');
    const dispatcher = makeDispatcher(makeTools(execute));
    const part = makeToolPart('call-1');
    const msg = makeAssistantMessage([part]);

    dispatcher.onUpdate(msg);
    dispatcher.sweep(msg);
    await dispatcher.settle();

    expect(execute).toHaveBeenCalledOnce();
    expect(dispatcher.dispatchedCount).toBe(1);
  });
});

describe('ToolDispatcher — guard checks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips non-tool parts', async () => {
    const execute = vi.fn();
    const dispatcher = makeDispatcher(makeTools(execute));
    dispatcher.onUpdate(
      makeAssistantMessage([{ type: 'text', text: 'hello' } as never]),
    );
    await dispatcher.settle();

    expect(execute).not.toHaveBeenCalled();
    expect(dispatcher.dispatchedCount).toBe(0);
  });

  it('skips provider-executed tools', async () => {
    const execute = vi.fn();
    const dispatcher = makeDispatcher(makeTools(execute));
    const part = makeToolPart('call-1');
    (part as { providerExecuted: boolean }).providerExecuted = true;

    dispatcher.onUpdate(makeAssistantMessage([part]));
    await dispatcher.settle();

    expect(execute).not.toHaveBeenCalled();
  });

  it('skips tool calls not in input-available state', async () => {
    const execute = vi.fn();
    const dispatcher = makeDispatcher(makeTools(execute));
    const part = makeToolPart('call-1', 'input-streaming');

    dispatcher.onUpdate(makeAssistantMessage([part]));
    await dispatcher.settle();

    expect(execute).not.toHaveBeenCalled();
  });

  it('skips tool calls in output-available state', async () => {
    const execute = vi.fn();
    const dispatcher = makeDispatcher(makeTools(execute));
    const part = makeToolPart('call-1', 'output-available');

    dispatcher.onUpdate(makeAssistantMessage([part]));
    await dispatcher.settle();

    expect(execute).not.toHaveBeenCalled();
  });
});

describe('ToolDispatcher — sweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('dispatches tool calls not seen during streaming', async () => {
    const execute = vi.fn().mockResolvedValue('result');
    const dispatcher = makeDispatcher(makeTools(execute));
    const part = makeToolPart('call-1');
    const msg = makeAssistantMessage([part]);

    // No onUpdate call — sweep finds it
    const swept = dispatcher.sweep(msg);
    await dispatcher.settle();

    expect(swept).toBe(1);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('returns 0 when message is null', async () => {
    const dispatcher = makeDispatcher();
    expect(dispatcher.sweep(null)).toBe(0);
  });

  it('does not re-dispatch tool calls already seen during streaming', async () => {
    const execute = vi.fn().mockResolvedValue('result');
    const dispatcher = makeDispatcher(makeTools(execute));
    const part = makeToolPart('call-1');
    const msg = makeAssistantMessage([part]);

    dispatcher.onUpdate(msg);
    const swept = dispatcher.sweep(msg);
    await dispatcher.settle();

    expect(swept).toBe(0);
    expect(execute).toHaveBeenCalledOnce();
  });
});

describe('ToolDispatcher — settle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('waits for all in-flight tool executions', async () => {
    const execute = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return 'done';
    });
    const dispatcher = makeDispatcher(makeTools(execute));
    dispatcher.onUpdate(
      makeAssistantMessage([makeToolPart('call-1'), makeToolPart('call-2')]),
    );

    // Tools are in-flight but not yet complete
    expect(dispatcher.inFlightCount).toBe(2);

    await dispatcher.settle();

    expect(execute).toHaveBeenCalledTimes(2);
  });
});

describe('ToolDispatcher — abort separation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('tool abort signal is not aborted by default', () => {
    const dispatcher = makeDispatcher();
    expect(dispatcher.toolAbortSignal.aborted).toBe(false);
  });

  it('abortTools aborts the tool abort signal', () => {
    const dispatcher = makeDispatcher();
    dispatcher.abortTools();
    expect(dispatcher.toolAbortSignal.aborted).toBe(true);
  });
});

describe('ToolDispatcher — execution outcomes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('executes directly from input-available without an approval-requested intermediate state', async () => {
    let seenState: string | undefined;
    const execute = vi.fn(async () => {
      seenState = asToolPart(part).state;
      return 'result';
    });
    const dispatcher = makeDispatcher(makeTools(execute));
    const part = makeToolPart('call-1');

    dispatcher.onUpdate(makeAssistantMessage([part]));
    await dispatcher.settle();

    expect(seenState).toBe('input-available');
    expect(asToolPart(part).approval).toBeUndefined();
  });

  it('sets output-available and stores output on success', async () => {
    const execute = vi.fn().mockResolvedValue({ data: 42 });
    const dispatcher = makeDispatcher(makeTools(execute));
    const part = makeToolPart('call-1');

    dispatcher.onUpdate(makeAssistantMessage([part]));
    await dispatcher.settle();

    const toolPart = asToolPart(part);
    expect(toolPart.state).toBe('output-available');
    expect(toolPart.output).toEqual({ data: 42 });
  });

  it('passes input and toolOptions to execute', async () => {
    const execute = vi.fn().mockResolvedValue('ok');
    const dispatcher = makeDispatcher(makeTools(execute));
    const part = makeToolPart('call-1');

    dispatcher.onUpdate(makeAssistantMessage([part]));
    await dispatcher.settle();

    expect(execute).toHaveBeenCalledWith(
      { query: 'test' },
      expect.objectContaining({
        toolCallId: 'call-1',
        messages: [],
        abortSignal: expect.any(AbortSignal),
      }),
    );
  });

  it('sets output-error with truncated message when execute throws', async () => {
    const longMessage = 'x'.repeat(600);
    const execute = vi.fn().mockRejectedValue(new Error(longMessage));
    const dispatcher = makeDispatcher(makeTools(execute));
    const part = makeToolPart('call-1');

    dispatcher.onUpdate(makeAssistantMessage([part]));
    await dispatcher.settle();

    const toolPart = asToolPart(part);
    expect(toolPart.state).toBe('output-error');
    expect(toolPart.errorText).toHaveLength(512);
    expect(toolPart.errorText).toBe('x'.repeat(512));
  });

  it('sets output-error with generic message when non-Error is thrown', async () => {
    const execute = vi.fn().mockRejectedValue('string error');
    const dispatcher = makeDispatcher(makeTools(execute));
    const part = makeToolPart('call-1');

    dispatcher.onUpdate(makeAssistantMessage([part]));
    await dispatcher.settle();

    const toolPart = asToolPart(part);
    expect(toolPart.state).toBe('output-error');
    expect(toolPart.errorText).toBe(
      'An unknown error happened during tool execution. Please try again.',
    );
  });

  it('sets output-error when tool has no execute function', async () => {
    const dispatcher = makeDispatcher(makeTools(undefined));
    const part = makeToolPart('call-1');

    dispatcher.onUpdate(makeAssistantMessage([part]));
    await dispatcher.settle();

    const toolPart = asToolPart(part);
    expect(toolPart.state).toBe('output-error');
    expect(toolPart.errorText).toBe('The tool is not implemented.');
  });

  it('logs and records error when tool is not found', async () => {
    const dispatcher = makeDispatcher({} as AgentTools);
    const part = makeToolPart('call-1', 'input-available', 'nonexistent');

    dispatcher.onUpdate(makeAssistantMessage([part]));
    await dispatcher.settle();

    // Error is caught and logged — part state remains input-available
    // since the throw happens before Object.assign
    expect(dispatcher.dispatchedCount).toBe(1);
  });

  it('records error.type on the span when execute throws (output-error)', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('boom'));
    const dispatcher = makeDispatcher(makeTools(execute));
    const part = makeToolPart('call-1');

    dispatcher.onUpdate(makeAssistantMessage([part]));
    await dispatcher.settle();

    // executeTool swallows the error and sets output-error state, so
    // the promise resolves. recordErrorOnSpan must still be called so
    // the trace surfaces the error with error.type.
    expect(asToolPart(part).state).toBe('output-error');
    expect(recordErrorOnSpan).toHaveBeenCalled();
  });

  it('records error.type on the span when tool has no execute function', async () => {
    const dispatcher = makeDispatcher(makeTools(undefined));
    const part = makeToolPart('call-1');

    dispatcher.onUpdate(makeAssistantMessage([part]));
    await dispatcher.settle();

    expect(asToolPart(part).state).toBe('output-error');
    expect(recordErrorOnSpan).toHaveBeenCalled();
  });

  it('does NOT record error when tool succeeds', async () => {
    const execute = vi.fn().mockResolvedValue('ok');
    const dispatcher = makeDispatcher(makeTools(execute));
    const part = makeToolPart('call-1');

    dispatcher.onUpdate(makeAssistantMessage([part]));
    await dispatcher.settle();

    expect(asToolPart(part).state).toBe('output-available');
    expect(recordErrorOnSpan).not.toHaveBeenCalled();
  });
});

describe('ToolDispatcher — execution timeout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('force-terminates a tool that exceeds the timeout', async () => {
    vi.useFakeTimers();

    const execute = vi.fn(
      (_input, opts) =>
        new Promise((_resolve, reject) => {
          opts.abortSignal?.addEventListener('abort', () =>
            reject(new Error('aborted')),
          );
        }),
    );
    const dispatcher = makeDispatcher(makeTools(execute), 100);
    const part = makeToolPart('call-1');

    dispatcher.onUpdate(makeAssistantMessage([part]));

    // Advance past the timeout
    const settlePromise = dispatcher.settle();
    vi.advanceTimersByTime(101);
    await settlePromise;

    const toolPart = asToolPart(part);
    expect(toolPart.state).toBe('output-error');
    expect(toolPart.errorText).toContain('timed out');

    vi.useRealTimers();
  });

  it('does not timeout tools that complete within the deadline', async () => {
    vi.useFakeTimers();

    const execute = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return 'done';
    });
    const dispatcher = makeDispatcher(makeTools(execute), 500);
    const part = makeToolPart('call-1');

    dispatcher.onUpdate(makeAssistantMessage([part]));

    const settlePromise = dispatcher.settle();
    vi.advanceTimersByTime(60);
    await settlePromise;

    const toolPart = asToolPart(part);
    expect(toolPart.state).toBe('output-available');
    expect(toolPart.output).toBe('done');

    vi.useRealTimers();
  });

  it('distinguishes timeout errors from session abort errors', async () => {
    vi.useFakeTimers();

    const execute = vi.fn(
      (_input, opts) =>
        new Promise((_resolve, reject) => {
          opts.abortSignal?.addEventListener('abort', () =>
            reject(new Error('aborted')),
          );
        }),
    );
    const dispatcher = makeDispatcher(makeTools(execute), 100);
    const part = makeToolPart('call-1');

    dispatcher.onUpdate(makeAssistantMessage([part]));

    // Abort the session-level signal (not the timeout)
    dispatcher.abortTools();
    await dispatcher.settle();

    const toolPart = asToolPart(part);
    expect(toolPart.state).toBe('output-error');
    // Should NOT say "timed out" since it was a session abort
    expect(toolPart.errorText).not.toContain('timed out');
    expect(toolPart.errorText).toBe('aborted');

    vi.useRealTimers();
  });
});
