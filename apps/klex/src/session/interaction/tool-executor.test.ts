import { jsonSchema, type Tool } from 'ai';
import { describe, expect, it, vi } from 'vitest';

import { testLogger as logger } from '@/session/chat/test-helpers';

import { ToolExecutor } from './tool-executor';

function createExecutor(
  execute: NonNullable<Tool['execute']>,
  timeoutMs?: number,
  inputSchema: Tool['inputSchema'] = jsonSchema({ type: 'object' }),
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
  });
}

describe('ToolExecutor', () => {
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
