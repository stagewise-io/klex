import type { ModelMessage } from 'ai';
import { type DynamicToolUIPart, getToolName, isToolUIPart } from 'ai';

import type { ModuleLogger } from '@stagewise/logger';

import { normalizeJsonValue, ToolExecutor } from '@/session/interaction';
import { recordErrorOnSpan } from '@/tracing';

import type { ExtendedUIMessage } from '../message-types';
import type { AgentTools } from '../tools';
import { startChildSpan } from '../utils/tracing';

/**
 * Owns at-most-once tool dispatch, tool execution, in-flight tracking, and
 * post-generation sweep logic.
 *
 * Created by the GenerationRunner. Stream updates are fed via
 * {@link onUpdate}. After generation completes (or aborts), {@link sweep}
 * catches any tool calls that were fully streamed but not yet dispatched,
 * and {@link settle} awaits all in-flight executions.
 *
 * Tools always run to completion even if the generation is aborted — the
 * internal `toolAbortController` is never aborted by this class. It is
 * exposed via {@link abortTools} for session-level shutdown only.
 */
export class ToolDispatcher {
  private readonly dispatchedToolCallIds = new Set<string>();
  private readonly toolExecutions: Promise<void>[] = [];
  private readonly toolExecutor: ToolExecutor;

  constructor(
    private readonly deps: {
      logger: ModuleLogger;
      tools: AgentTools;
      modelMessages: ModelMessage[];
      /** Per-tool execution timeout in ms. Defaults to 30 seconds. */
      toolTimeoutMs?: number;
      /** UUID of the session that owns this dispatcher. */
      sessionId: string;
    },
  ) {
    this.toolExecutor = new ToolExecutor({
      logger: deps.logger,
      tools: deps.tools,
      modelMessages: deps.modelMessages,
      sessionId: deps.sessionId,
      ...(deps.toolTimeoutMs !== undefined && {
        timeoutMs: deps.toolTimeoutMs,
      }),
    });
  }

  /** Number of tool calls dispatched so far. */
  get dispatchedCount(): number {
    return this.dispatchedToolCallIds.size;
  }

  /** Number of in-flight tool executions. */
  get inFlightCount(): number {
    return this.toolExecutions.length;
  }

  /**
   * Processes a streamed message update. Dispatches any tool call parts
   * that have reached `input-available` state and haven't been dispatched yet.
   */
  onUpdate(msg: ExtendedUIMessage): void {
    for (const part of msg.parts) {
      this.dispatchToolCall(part);
    }
  }

  /**
   * Sweeps the final message for tool calls that were fully streamed but
   * not yet dispatched (e.g. due to abort mid-stream). Returns the number
   * of additional tool calls dispatched.
   */
  sweep(message: ExtendedUIMessage | null): number {
    if (!message) return 0;
    const before = this.dispatchedToolCallIds.size;
    for (const part of message.parts) {
      this.dispatchToolCall(part);
    }
    return this.dispatchedToolCallIds.size - before;
  }

  /**
   * Waits for all in-flight tool executions to finish.
   * Includes tools dispatched during streaming AND tools dispatched by sweep.
   */
  async settle(): Promise<void> {
    await Promise.all(this.toolExecutions);
  }

  /** Aborts all in-flight tool executions. Use only during session shutdown. */
  abortTools(): void {
    this.toolExecutor.abort();
  }

  /** The abort signal passed to tool executions. */
  get toolAbortSignal(): AbortSignal {
    return this.toolExecutor.signal;
  }

  /**
   * Dispatch a single tool call for execution if it hasn't been
   * dispatched yet. Executes the tool in place — mutates the part's
   * state, output, and error fields directly on the original object.
   *
   * Guards (at-most-once execution):
   * - Not a tool UI part → skip
   * - Provider-executed → skip
   * - Not in 'input-available' state → skip (already executing or done)
   * - Already in dispatchedToolCallIds → skip (race protection)
   */
  private dispatchToolCall = (
    part: ExtendedUIMessage['parts'][number],
  ): void => {
    if (!isToolUIPart(part)) return;
    if (part.providerExecuted) return;
    if (part.state !== 'input-available') return;
    if (this.dispatchedToolCallIds.has(part.toolCallId)) return;

    // Mark as dispatched before starting execution to prevent races
    this.dispatchedToolCallIds.add(part.toolCallId);

    const toolName = getToolName(part);
    this.deps.logger.debug(
      { toolName, toolCallId: part.toolCallId, input: part.input },
      'Tool execution started',
    );

    const toolSpan = startChildSpan(`execute_tool ${toolName}`, {
      attributes: {
        'gen_ai.operation.name': 'execute_tool',
        'gen_ai.tool.name': toolName,
        'gen_ai.tool.call.id': part.toolCallId,
        'gen_ai.tool.type': 'function',
      },
    });

    this.toolExecutions.push(
      this.executeTool(part as DynamicToolUIPart, toolName)
        .then(() => {
          // biome-ignore lint/suspicious/noExplicitAny: execution mutates part state in place, TS can't track it
          const p = part as any;
          toolSpan.setAttribute('gen_ai.tool.state', p.state);
          if (p.state === 'output-available' && p.output !== undefined) {
            toolSpan.setAttribute(
              'gen_ai.tool.output',
              JSON.stringify(p.output),
            );
          } else if (p.state === 'output-error') {
            // executeTool swallows tool errors and converts them to
            // output-error state, so the promise resolves. Record the
            // error on the span here so the trace surfaces it.
            recordErrorOnSpan(
              toolSpan,
              new Error(p.errorText ?? 'Tool execution failed'),
            );
          }
          toolSpan.end();
          this.deps.logger.debug(
            {
              toolName,
              toolCallId: part.toolCallId,
              input: p.input,
              output: p.output,
              state: p.state,
            },
            'Tool execution finished',
          );
        })
        .catch((error) => {
          // Only reached for unexpected errors that escape executeTool
          // (e.g. tool not found, internal assertion failures).
          recordErrorOnSpan(toolSpan, error);
          toolSpan.end();
          this.deps.logger.error(
            {
              toolName,
              toolCallId: part.toolCallId,
              input: part.input,
              error,
            },
            'Tool execution failed',
          );
        }),
    );
  };

  /**
   * Execute a single tool call part in place. Mutates the part's state,
   * output, and error fields directly on the original object so that
   * changes are visible in the message's parts array.
   */
  private async executeTool(
    part: DynamicToolUIPart,
    toolName: string,
  ): Promise<void> {
    const input = normalizeJsonValue(part.input);
    if (input === undefined) {
      Object.assign(part, {
        state: 'output-error',
        errorText: 'The tool input cannot be represented as JSON.',
      });
      return;
    }
    const result = await this.toolExecutor.execute({
      executionId: part.toolCallId,
      name: toolName,
      input,
    });
    if (result.status === 'success') {
      Object.assign(part, {
        output: result.output,
        state: 'output-available',
      });
      return;
    }
    Object.assign(part, {
      state: 'output-error',
      errorText: result.error,
    });
  }
}
