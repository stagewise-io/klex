import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createQuickJsRuntime,
  type PersistentQuickJsRuntime,
  type QuickJsExecutionOptions,
} from './quickjs-runtime';

describe('QuickJS error ownership', () => {
  let runtime: PersistentQuickJsRuntime;

  beforeEach(async () => {
    runtime = await createQuickJsRuntime({
      memoryBytes: 64 * 1024 * 1024,
      stackBytes: 1024 * 1024,
    });
  });

  afterEach(() => {
    runtime.dispose();
  });

  function execute(
    source: string,
    request: QuickJsExecutionOptions['request'] = async () => null,
  ) {
    return runtime.execute({
      source,
      snapshot: { namespaces: [] },
      deadline: Date.now() + 5_000,
      maximumOutputBytes: 262_144,
      request,
    });
  }

  it('preserves syntax errors and accepts a subsequent execution', async () => {
    const request = vi.fn(async () => null);
    await expect(execute('return ();', request)).rejects.toMatchObject({
      name: 'SyntaxError',
      message: expect.stringContaining("unexpected token in expression: ')'"),
    });
    expect(request).not.toHaveBeenCalled();
    await expect(execute('return 42;')).resolves.toBe(42);
  });

  it('preserves pending-job exceptions and accepts a subsequent execution', async () => {
    const request = vi.fn(async () => null);
    await expect(
      execute(
        `
        const promise = Promise.resolve();
        // A throwing species resolve function escapes the reaction job itself,
        // unlike a normal .then callback that only rejects another promise.
        promise.constructor = {
          [Symbol.species]: function(executor) {
            executor(
              () => { throw new Error('pending job failure'); },
              () => { throw new Error('pending job failure'); },
            );
          },
        };
        promise.then(() => 42);
      `,
        request,
      ),
    ).rejects.toMatchObject({
      name: 'Error',
      message: 'pending job failure',
    });
    expect(request).not.toHaveBeenCalled();
    await expect(execute('return 42;')).resolves.toBe(42);
  });

  it('preserves asynchronous provider rejections and accepts a subsequent execution', async () => {
    const request = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      throw new Error('provider unavailable');
    });
    await expect(
      execute('return await tools.search("example");', request),
    ).rejects.toThrow('provider unavailable');
    expect(request).toHaveBeenCalledExactlyOnceWith({
      operation: 'search',
      query: 'example',
    });
    await expect(execute('return 42;')).resolves.toBe(42);
  });
});
