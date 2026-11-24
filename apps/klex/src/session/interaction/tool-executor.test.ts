import { jsonSchema, type Tool } from 'ai';
import { describe, expect, it, vi } from 'vitest';

import { testLogger as logger } from '@/session/chat/test-helpers';
import type { ToolRequestContext } from '@/tool-provider';

import { ToolExecutor } from './tool-executor';

function createExecutor(
  execute: NonNullable<Tool['execute']>,
  timeoutMs?: number,
  inputSchema: Tool['inputSchema'] = jsonSchema({ type: 'object' }),
  maxResultBytes?: number,
  recordToolCall?: (
    toolName: string,
    success: boolean,
    durationMs: number,
    errorType?: string,
  ) => void,
) {
  return new ToolExecutor({
    logger,
    tools: {
      example: {
        inputSchema,
        execute,
      },
    },
    modelMessages: [],
    sessionId: 'session-1',
    validateInput: true,
    ...(timeoutMs !== undefined && { timeoutMs }),
    ...(maxResultBytes !== undefined && { maxResultBytes }),
    recordToolCall,
  });
}

describe('ToolExecutor', () => {
  it('allows recall beyond the ordinary tool deadline and makes its deadline non-retryable', async () => {
    vi.useFakeTimers();
    try {
      const executor = new ToolExecutor({
        logger,
        tools: {
          recallFromMemory: {
            inputSchema: jsonSchema({ type: 'object' }),
            execute: async () => new Promise(() => {}),
          },
        },
        modelMessages: [],
        sessionId: 'session-1',
        validateInput: true,
      });
      let settled = false;
      const pending = executor
        .execute({ executionId: 'recall', name: 'recallFromMemory', input: {} })
        .then((result) => {
          settled = true;
          return result;
        });
      await vi.advanceTimersByTimeAsync(30_001);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(280_000);
      expect(await pending).toMatchObject({
        status: 'error',
        code: 'timeout',
        retryable: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds aggregate invocation evidence before returning it', async () => {
    const executor = createExecutor(async (_input, options) => {
      const context = options.context as ToolRequestContext;
      for (let index = 0; index < 60; index++)
        context.onMcpInvocation?.({
          id: String(index),
          executionId: context.executionId,
          namespace: 'test',
          name: 'large',
          input: { text: 'x'.repeat(20000) },
        });
      return {};
    });
    const result = await executor.execute({
      executionId: 'bounded',
      name: 'example',
      input: {},
    });
    expect(
      Buffer.byteLength(JSON.stringify(result.mcpInvocations)),
    ).toBeLessThanOrEqual(256 * 1024);
    expect(result.mcpInvocations?.at(-1)?.input).toMatchObject({
      omittedInvocations: expect.any(Number),
    });
  });
  it('retains deduplicated correlated invocations on failure and ignores another execution', async () => {
    const executor = createExecutor(async (_input, options) => {
      const context = options.context as ToolRequestContext;
      const invocation = {
        id: 'invocation-1',
        executionId: context.executionId,
        namespace: 'slack',
        name: 'send',
        input: { channel: 'C1' },
      };
      context.onMcpInvocation?.(invocation);
      context.onMcpInvocation?.(invocation);
      context.onMcpInvocation?.({
        ...invocation,
        id: 'wrong',
        executionId: 'other-execution',
      });
      throw new Error('sandbox failed after invoking');
    });
    const result = await executor.execute({
      executionId: 'execution-1',
      name: 'example',
      input: {},
    });
    expect(result.status).toBe('error');
    expect(result.mcpInvocations).toEqual([
      {
        id: 'invocation-1',
        executionId: 'execution-1',
        namespace: 'slack',
        name: 'send',
        input: { channel: 'C1' },
      },
    ]);
  });

  it('retains invocation evidence on cancellation and isolates concurrent runtime instances', async () => {
    const started = Promise.withResolvers<void>();
    const cancelled = createExecutor(async (_input, options) => {
      const context = options.context as ToolRequestContext;
      context.onMcpInvocation?.({
        id: 'same-id',
        executionId: context.executionId,
        namespace: 'slack',
        name: 'send',
        input: { channel: 'cancelled' },
      });
      started.resolve();
      return new Promise(() => {});
    });
    const other = createExecutor(async (_input, options) => {
      const context = options.context as ToolRequestContext;
      context.onMcpInvocation?.({
        id: 'same-id',
        executionId: context.executionId,
        namespace: 'slack',
        name: 'send',
        input: { channel: 'other' },
      });
      return { done: true };
    });
    const request = { executionId: 'same-outer', name: 'example', input: {} };
    const pending = cancelled.execute(request);
    const successful = other.execute(request);
    await started.promise;
    cancelled.abort();
    const [failed, completed] = await Promise.all([pending, successful]);
    expect(failed).toMatchObject({
      status: 'error',
      code: 'aborted',
      mcpInvocations: [{ input: { channel: 'cancelled' } }],
    });
    expect(completed).toMatchObject({
      status: 'success',
      mcpInvocations: [{ input: { channel: 'other' } }],
    });
  });

  it('executes the same execution id at most once', async () => {
    const execute = vi.fn(async () => ({ value: 1 }));
    const executor = createExecutor(execute);
    const request = {
      executionId: 'execution-1',
      name: 'example',
      input: { value: 1 },
    } as const;

    const [first, duplicate] = await Promise.all([
      executor.execute(request),
      executor.execute(request),
    ]);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(duplicate).toEqual(first);
  });

  it('records one terminal telemetry event for duplicate callers', async () => {
    const recordToolCall = vi.fn();
    const executor = createExecutor(
      async () => ({ value: 1 }),
      undefined,
      undefined,
      undefined,
      recordToolCall,
    );
    const request = {
      executionId: 'execution-1',
      name: 'example',
      input: { value: 1 },
    } as const;

    await Promise.all([executor.execute(request), executor.execute(request)]);

    expect(recordToolCall).toHaveBeenCalledTimes(1);
    expect(recordToolCall).toHaveBeenCalledWith(
      'example',
      true,
      expect.any(Number),
      undefined,
    );
  });

  it('rejects invalid input before tool execution', async () => {
    const execute = vi.fn(async () => ({ value: 1 }));
    const executor = createExecutor(
      execute,
      undefined,
      jsonSchema({
        type: 'object',
        required: ['value'],
        properties: { value: { type: 'number' } },
      }),
    );

    await expect(
      executor.execute({
        executionId: 'execution-1',
        name: 'example',
        input: { value: 'not-a-number' },
      }),
    ).resolves.toMatchObject({
      status: 'error',
      code: 'invalid-input',
      retryable: false,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('normalizes schema construction failures into an invalid-input result', async () => {
    const execute = vi.fn(async () => ({ value: 1 }));
    const executor = createExecutor(
      execute,
      undefined,
      jsonSchema(
        { type: 'object' },
        {
          validate: async () => {
            throw new Error('validator unavailable');
          },
        },
      ),
    );

    await expect(
      executor.execute({
        executionId: 'execution-1',
        name: 'example',
        input: {},
      }),
    ).resolves.toMatchObject({
      status: 'error',
      code: 'invalid-input',
      error: expect.any(String) as string,
      retryable: false,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('normalizes missing tools into a stable error result', async () => {
    const executor = new ToolExecutor({
      logger,
      tools: {},
      modelMessages: [],
      sessionId: 'session-1',
    });

    await expect(
      executor.execute({
        executionId: 'execution-1',
        name: 'missing',
        input: {},
      }),
    ).resolves.toMatchObject({
      status: 'error',
      code: 'tool-not-found',
      retryable: false,
    });
  });

  it('rejects an oversized serialized tool result before it reaches history', async () => {
    const executor = createExecutor(
      async () => ({ payload: 'x'.repeat(32) }),
      undefined,
      undefined,
      16,
    );

    await expect(
      executor.execute({
        executionId: 'execution-1',
        name: 'example',
        input: {},
      }),
    ).resolves.toMatchObject({
      status: 'error',
      code: 'result-too-large',
      retryable: false,
    });
  });

  it('rejects oversized results with the default result limit', async () => {
    const executor = createExecutor(async () => ({
      payload: 'x'.repeat(256 * 1024),
    }));

    await expect(
      executor.execute({
        executionId: 'execution-1',
        name: 'example',
        input: {},
      }),
    ).resolves.toMatchObject({
      status: 'error',
      code: 'result-too-large',
      retryable: false,
    });
  });

  it('enforces the timeout when a tool ignores cancellation', async () => {
    vi.useFakeTimers();
    try {
      const executor = createExecutor(
        async () => new Promise(() => undefined),
        25,
      );
      const execution = executor.execute({
        executionId: 'execution-1',
        name: 'example',
        input: {},
      });

      await vi.advanceTimersByTimeAsync(25);

      await expect(execution).resolves.toMatchObject({
        status: 'error',
        code: 'timeout',
        retryable: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('normalizes timeouts into retryable error results', async () => {
    const executor = createExecutor(
      async (_input, options) =>
        new Promise((_resolve, reject) => {
          options.abortSignal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
      1,
    );

    await expect(
      executor.execute({
        executionId: 'execution-1',
        name: 'example',
        input: {},
      }),
    ).resolves.toMatchObject({
      status: 'error',
      code: 'timeout',
      retryable: true,
    });
  });
});
