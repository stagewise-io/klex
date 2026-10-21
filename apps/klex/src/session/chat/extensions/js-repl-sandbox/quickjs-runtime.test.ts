import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodingCases, encodingErrors } from './encoding.fixture';

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
      stackBytes: 256 * 1024,
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

  it('preserves own __proto__ properties in provider results', async () => {
    const payload = JSON.parse('{"__proto__":{"polluted":true},"normal":1}');
    await expect(
      execute(
        `const res = await tools.search('example');
      return { res, own: Object.prototype.hasOwnProperty.call(res, '__proto__') };`,
        async () => payload,
      ),
    ).resolves.toEqual({ res: payload, own: true });
  });

  it('recovers from guest stack overflow', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(
        execute('const recurse = () => 1 + recurse(); return recurse();'),
      ).rejects.toMatchObject({
        name: 'RangeError',
        message: expect.stringContaining('Maximum call stack size exceeded'),
      });
    }
    await expect(execute('return 42')).resolves.toBe(42);
  });

  it('recovers from guest out-of-memory errors', async () => {
    runtime.dispose();
    runtime = await createQuickJsRuntime({
      memoryBytes: 2 * 1024 * 1024,
      stackBytes: 256 * 1024,
    });
    await expect(
      execute(`return 'x'.repeat(10 * 1024 * 1024);`),
    ).rejects.toMatchObject({
      name: 'InternalError',
      message: expect.stringContaining('out of memory'),
    });
    await expect(execute('return 42')).resolves.toBe(42);
  });

  it('preserves syntax errors and accepts a subsequent execution', async () => {
    const request = vi.fn(async () => null);
    await expect(execute('return ();', request)).rejects.toMatchObject({
      name: 'SyntaxError',
      message: expect.stringContaining("unexpected token in expression: ')'"),
    });
    expect(request).not.toHaveBeenCalled();
    await expect(execute('return 42;')).resolves.toBe(42);
  });

  it.each(encodingCases)('supports $name', async ({ code, expected }) => {
    await expect(execute(code)).resolves.toEqual(expected);
  });

  it.each(encodingErrors)(
    'preserves encoding error $name',
    async ({ code, name }) => {
      await expect(execute(code)).rejects.toMatchObject({
        name,
        message: expect.stringMatching(/.+/),
      });
      await expect(execute('return 42')).resolves.toBe(42);
    },
  );

  it.each(['resolve', 'reject'])(
    'ignores late host %s after VM disposal',
    async (settlement) => {
      const pending = Promise.withResolvers<null>();
      const started = Promise.withResolvers<void>();
      const execution = execute('await tools.search("late")', () => {
        started.resolve();
        return pending.promise;
      });
      const rejected = expect(execution).rejects.toThrow('disposed');
      await started.promise;
      runtime.dispose();
      if (settlement === 'resolve') pending.resolve(null);
      else pending.reject(new Error('late rejection'));
      await rejected;
      await expect(execute('return 42')).rejects.toThrow('disposed');
    },
  );

  it('preserves primitive rejection strings', async () => {
    await expect(execute(`throw 'primitive failure'`)).rejects.toMatchObject({
      name: 'Error',
      message: 'primitive failure',
    });
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
