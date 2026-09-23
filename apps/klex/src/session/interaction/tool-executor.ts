import type { JSONValue } from '@ai-sdk/provider';
import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import { asSchema, type ModelMessage, type Tool, type ToolSet } from 'ai';
import { z } from 'zod';

import type { ModuleLogger } from '@stagewise/logger';

import type { ToolRequestContext } from '@/tool-provider';

import {
  DEFAULT_TOOL_RESULT_MAX_BYTES,
  exceedsToolResultLimit,
} from './tool-result-limit';
import type {
  InteractionToolRequest,
  InteractionToolResult,
  SessionToolRuntime,
} from './types';

const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
const TOOL_ATTRIBUTE_PREVIEW_LIMIT = 4_096;
const TOOL_ATTRIBUTE_MAX_DEPTH = 8;
const TOOL_ATTRIBUTE_MAX_NODES = 256;

function boundedToolAttribute(value: unknown): string {
  let visitedNodes = 0;
  const seen = new WeakSet<object>();
  const project = (entry: unknown, depth: number): unknown => {
    if (visitedNodes >= TOOL_ATTRIBUTE_MAX_NODES) return '[truncated]';
    visitedNodes += 1;
    if (typeof entry === 'string') return entry.slice(0, 1_024);
    if (typeof entry === 'bigint') return entry.toString();
    if (typeof entry !== 'object' || entry === null) return entry;
    if (depth >= TOOL_ATTRIBUTE_MAX_DEPTH) return '[max-depth]';
    if (seen.has(entry)) return '[circular]';
    seen.add(entry);
    if (Array.isArray(entry)) {
      return entry.slice(0, 32).map((item) => project(item, depth + 1));
    }
    return Object.fromEntries(
      Object.entries(entry)
        .slice(0, 64)
        .map(([key, item]) => [key, project(item, depth + 1)]),
    );
  };

  try {
    return (JSON.stringify(project(value, 0)) ?? 'null').slice(
      0,
      TOOL_ATTRIBUTE_PREVIEW_LIMIT,
    );
  } catch {
    return '[unserializable]';
  }
}

export function normalizeJsonValue(value: unknown): JSONValue | undefined {
  if (value === undefined) return null;
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return undefined;
    return JSON.parse(serialized) as JSONValue;
  } catch {
    return undefined;
  }
}

async function validateToolInput(
  tool: Pick<Tool, 'inputSchema'>,
  input: JSONValue,
): Promise<
  { success: true; value: unknown } | { success: false; error: string }
> {
  const schema = asSchema(tool.inputSchema);
  if (schema.validate) {
    const result = await schema.validate(input);
    return result.success
      ? { success: true, value: result.value }
      : { success: false, error: String(result.error) };
  }

  const rawJsonSchema = await schema.jsonSchema;
  const jsonSchema =
    rawJsonSchema.type === 'object' &&
    rawJsonSchema.additionalProperties === undefined
      ? { ...rawJsonSchema, additionalProperties: true }
      : rawJsonSchema;
  const result = z
    .fromJSONSchema(jsonSchema as Parameters<typeof z.fromJSONSchema>[0])
    .safeParse(input);
  return result.success
    ? { success: true, value: result.data }
    : { success: false, error: result.error.message };
}

function errorResult(
  executionId: string,
  code: Extract<InteractionToolResult, { status: 'error' }>['code'],
  error: string,
  retryable: boolean,
): InteractionToolResult {
  return { executionId, status: 'error', code, error, retryable };
}

export class ToolExecutor implements SessionToolRuntime {
  private readonly executions = new Map<
    string,
    Promise<InteractionToolResult>
  >();
  private readonly abortController = new AbortController();

  constructor(
    private readonly deps: {
      logger: ModuleLogger;
      tools: ToolSet;
      modelMessages: readonly ModelMessage[];
      sessionId: string;
      timeoutMs?: number;
      validateInput?: boolean;
      /** Maximum serialized JSON size of one tool result. */
      maxResultBytes?: number;
      recordToolCall?: (
        toolName: string,
        success: boolean,
        durationMs: number,
        errorType?: string,
      ) => void;
    },
  ) {}

  get tools(): ToolSet {
    return this.deps.tools;
  }

  execute(request: InteractionToolRequest): Promise<InteractionToolResult> {
    const existing = this.executions.get(request.executionId);
    if (existing) return existing;

    const execution = this.executeOnce(request);
    this.executions.set(request.executionId, execution);
    return execution;
  }

  abort(): void {
    this.abortController.abort();
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  private async executeOnce(
    request: InteractionToolRequest,
  ): Promise<InteractionToolResult> {
    const startedAt = performance.now();
    const toolSpan = trace
      .getTracer('klex')
      .startSpan(`execute_tool ${request.name}`, {
        attributes: {
          'gen_ai.operation.name': 'execute_tool',
          'gen_ai.tool.name': request.name,
          'gen_ai.tool.call.id': request.executionId,
          'gen_ai.tool.type': 'function',
          'klex.session.id': this.deps.sessionId,
        },
      });
    const toolContext = trace.setSpan(context.active(), toolSpan);
    const finish = (result: InteractionToolResult): InteractionToolResult => {
      const durationMs = performance.now() - startedAt;
      const success = result.status === 'success';
      if (toolSpan.isRecording()) {
        toolSpan.setAttribute(
          'gen_ai.tool.call.result',
          boundedToolAttribute(result),
        );
        toolSpan.setAttribute('klex.outcome', success ? 'success' : 'error');
        if (!success) {
          toolSpan.setAttribute('error.type', result.code);
          toolSpan.setStatus({
            code: SpanStatusCode.ERROR,
            message: result.code,
          });
        }
      }
      try {
        this.deps.recordToolCall?.(
          request.name,
          success,
          durationMs,
          success ? undefined : result.code,
        );
      } catch {
        // Telemetry must never change the tool result.
      }
      this.deps.logger.info(
        {
          'event.name': 'tool.call_completed',
          'klex.session.id': this.deps.sessionId,
          'gen_ai.tool.name': request.name,
          'gen_ai.tool.call.id': request.executionId,
          'klex.outcome': success ? 'success' : 'error',
          duration_ms: durationMs,
          ...(success ? {} : { 'error.type': result.code }),
        },
        'Tool call completed',
      );
      toolSpan.end();
      return result;
    };

    return context.with(toolContext, async () => {
      const tool = (this.deps.tools as Record<string, Tool | undefined>)[
        request.name
      ];
      if (!tool) {
        return finish(
          errorResult(
            request.executionId,
            'tool-not-found',
            `The requested tool ${request.name} was not found.`,
            false,
          ),
        );
      }
      if (!tool.execute) {
        return finish(
          errorResult(
            request.executionId,
            'tool-not-implemented',
            'The tool is not implemented.',
            false,
          ),
        );
      }

      const validation = this.deps.validateInput
        ? await validateToolInput(tool, request.input).catch(
            (error: unknown) => ({
              success: false as const,
              error: error instanceof Error ? error.message : String(error),
            }),
          )
        : { success: true as const, value: request.input };
      if (!validation.success) {
        this.deps.logger.warn(
          {
            executionId: request.executionId,
            toolName: request.name,
            error: validation.error,
          },
          'Realtime tool input failed schema validation',
        );
        return finish(
          errorResult(
            request.executionId,
            'invalid-input',
            validation.error,
            false,
          ),
        );
      }

      if (toolSpan.isRecording()) {
        toolSpan.setAttribute(
          'gen_ai.tool.call.arguments',
          boundedToolAttribute(validation.value),
        );
      }

      const timeoutMs = this.deps.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
      const timeoutController = new AbortController();
      const timeoutTimer = setTimeout(
        () => timeoutController.abort(),
        timeoutMs,
      );
      const signal = AbortSignal.any([
        this.abortController.signal,
        timeoutController.signal,
      ]);
      let resolveCancellation!: () => void;
      const cancellation = new Promise<void>((resolve) => {
        resolveCancellation = resolve;
        if (signal.aborted) resolve();
        else
          signal.addEventListener('abort', resolveCancellation, {
            once: true,
          });
      });

      this.deps.logger.debug(
        {
          sessionId: this.deps.sessionId,
          toolName: request.name,
          toolCallId: request.executionId,
        },
        'Tool execution started',
      );

      try {
        const toolRequestContext: ToolRequestContext = {
          executionId: request.executionId,
          signal,
          sessionId: this.deps.sessionId,
        };
        const execution = Promise.resolve(
          tool.execute(validation.value, {
            toolCallId: request.executionId,
            messages: [...this.deps.modelMessages],
            // biome-ignore lint/suspicious/noExplicitAny: AI SDK context is generic while Klex tools require ToolRequestContext
            context: toolRequestContext as any,
            abortSignal: signal,
          }),
        ).then((output) => ({ type: 'completed' as const, output }));
        const outcome = await Promise.race([
          execution,
          cancellation.then(() => ({ type: 'cancelled' as const })),
        ]);
        if (outcome.type === 'cancelled') {
          return finish(
            timeoutController.signal.aborted
              ? errorResult(
                  request.executionId,
                  'timeout',
                  `Tool execution timed out after ${timeoutMs}ms.`,
                  true,
                )
              : errorResult(
                  request.executionId,
                  'aborted',
                  'Tool execution was aborted.',
                  true,
                ),
          );
        }
        const jsonOutput = normalizeJsonValue(outcome.output);
        if (jsonOutput === undefined) {
          return finish(
            errorResult(
              request.executionId,
              'invalid-output',
              'The tool returned a value that cannot be represented as JSON.',
              false,
            ),
          );
        }
        const maxResultBytes =
          this.deps.maxResultBytes ?? DEFAULT_TOOL_RESULT_MAX_BYTES;
        if (exceedsToolResultLimit(jsonOutput, maxResultBytes)) {
          this.deps.logger.warn(
            {
              executionId: request.executionId,
              toolName: request.name,
              maxResultBytes,
            },
            'Tool result exceeded the configured serialized-size limit',
          );
          return finish(
            errorResult(
              request.executionId,
              'result-too-large',
              `The tool result exceeds the configured ${maxResultBytes}-byte limit.`,
              false,
            ),
          );
        }
        return finish({
          executionId: request.executionId,
          status: 'success',
          output: jsonOutput,
        });
      } catch (error) {
        if (toolSpan.isRecording() && error instanceof Error) {
          toolSpan.recordException(error);
        }
        const timedOut =
          timeoutController.signal.aborted &&
          !this.abortController.signal.aborted;
        if (timedOut) {
          return finish(
            errorResult(
              request.executionId,
              'timeout',
              `Tool execution timed out after ${timeoutMs}ms.`,
              true,
            ),
          );
        }
        if (this.abortController.signal.aborted) {
          return finish(
            errorResult(
              request.executionId,
              'aborted',
              error instanceof Error
                ? error.message.slice(0, 512)
                : 'Tool execution was aborted.',
              true,
            ),
          );
        }
        return finish(
          errorResult(
            request.executionId,
            'execution-failed',
            error instanceof Error
              ? error.message.slice(0, 512)
              : 'An unknown error happened during tool execution. Please try again.',
            true,
          ),
        );
      } finally {
        clearTimeout(timeoutTimer);
        signal.removeEventListener('abort', resolveCancellation);
      }
    });
  }
}
