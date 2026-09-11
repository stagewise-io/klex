import type { JSONValue } from '@ai-sdk/provider';
import { asSchema, type ModelMessage, type Tool, type ToolSet } from 'ai';
import { z } from 'zod';

import type { ModuleLogger } from '@stagewise/logger';

import type { ToolRequestContext } from '@/tool-provider';

import type {
  InteractionToolRequest,
  InteractionToolResult,
  SessionToolRuntime,
} from './types';

const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

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

  const jsonSchema =
    schema.jsonSchema.type === 'object' &&
    schema.jsonSchema.additionalProperties === undefined
      ? { ...schema.jsonSchema, additionalProperties: true }
      : schema.jsonSchema;
  const result = z.fromJSONSchema(jsonSchema).safeParse(input);
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
    const tool = (this.deps.tools as Record<string, Tool | undefined>)[
      request.name
    ];
    if (!tool) {
      return errorResult(
        request.executionId,
        'tool-not-found',
        `The requested tool ${request.name} was not found.`,
        false,
      );
    }
    if (!tool.execute) {
      return errorResult(
        request.executionId,
        'tool-not-implemented',
        'The tool is not implemented.',
        false,
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
      return errorResult(
        request.executionId,
        'invalid-input',
        validation.error,
        false,
      );
    }

    const timeoutMs = this.deps.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    const timeoutController = new AbortController();
    const timeoutTimer = setTimeout(() => timeoutController.abort(), timeoutMs);
    const signal = AbortSignal.any([
      this.abortController.signal,
      timeoutController.signal,
    ]);
    let resolveCancellation!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      resolveCancellation = resolve;
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', () => resolve(), { once: true });
    });

    this.deps.logger.debug(
      {
        sessionId: this.deps.sessionId,
        toolName: request.name,
        toolExecutionId: request.executionId,
      },
      'Tool execution started',
    );

    try {
      const context: ToolRequestContext = {
        executionId: request.executionId,
        signal,
        sessionId: this.deps.sessionId,
      };
      const execution = Promise.resolve(
        tool.execute(validation.value, {
          toolCallId: request.executionId,
          messages: [...this.deps.modelMessages],
          // biome-ignore lint/suspicious/noExplicitAny: AI SDK context is generic while Klex tools require ToolRequestContext
          context: context as any,
          abortSignal: signal,
        }),
      ).then((output) => ({ type: 'completed' as const, output }));
      const outcome = await Promise.race([
        execution,
        cancellation.then(() => ({ type: 'cancelled' as const })),
      ]);
      if (outcome.type === 'cancelled') {
        if (timeoutController.signal.aborted) {
          return errorResult(
            request.executionId,
            'timeout',
            `Tool execution timed out after ${timeoutMs}ms.`,
            true,
          );
        }
        return errorResult(
          request.executionId,
          'aborted',
          'Tool execution was aborted.',
          true,
        );
      }
      const jsonOutput = normalizeJsonValue(outcome.output);
      if (jsonOutput === undefined) {
        return errorResult(
          request.executionId,
          'invalid-output',
          'The tool returned a value that cannot be represented as JSON.',
          false,
        );
      }
      return {
        executionId: request.executionId,
        status: 'success',
        output: jsonOutput,
      };
    } catch (error) {
      const timedOut =
        timeoutController.signal.aborted &&
        !this.abortController.signal.aborted;
      if (timedOut) {
        return errorResult(
          request.executionId,
          'timeout',
          `Tool execution timed out after ${timeoutMs}ms.`,
          true,
        );
      }
      if (this.abortController.signal.aborted) {
        return errorResult(
          request.executionId,
          'aborted',
          error instanceof Error
            ? error.message.slice(0, 512)
            : 'Tool execution was aborted.',
          true,
        );
      }
      return errorResult(
        request.executionId,
        'execution-failed',
        error instanceof Error
          ? error.message.slice(0, 512)
          : 'An unknown error happened during tool execution. Please try again.',
        true,
      );
    } finally {
      clearTimeout(timeoutTimer);
      signal.removeEventListener('abort', resolveCancellation);
    }
  }
}
