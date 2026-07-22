import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ModuleLogger, RootLogger } from '@stagewise/logger';

import { InMemoryToolProvider } from './in-memory-tool-provider.fixture';
import { createJavaScriptTool, type JavaScriptTool } from './javascript';

const logging = {
  child: () => ({ info: () => undefined }) as unknown as ModuleLogger,
} as unknown as RootLogger;
const workerUrl = new URL(
  '../../../../dist/javascript-sandbox-worker.js',
  import.meta.url,
);

describe('JavaScriptTool', () => {
  let javaScriptTool: JavaScriptTool;
  let provider: InMemoryToolProvider;

  beforeEach(async () => {
    provider = new InMemoryToolProvider();
    javaScriptTool = createJavaScriptTool({ logging, provider, workerUrl });
    await javaScriptTool.start();
  });

  afterEach(async () => {
    await javaScriptTool.close();
  });

  it('exposes only runJavascript and delegates execution', async () => {
    expect(Object.keys(javaScriptTool.tools)).toEqual(['runJavascript']);
    const runJavascript = javaScriptTool.tools.runJavascript;
    expect(runJavascript).toBeDefined();
    const execute = runJavascript?.execute as
      | ((input: { code: string }, options: object) => Promise<unknown>)
      | undefined;
    expect(execute).toBeDefined();
    await expect(
      execute?.(
        { code: 'return 42' },
        { toolCallId: 'tool-call', messages: [] },
      ),
    ).resolves.toBe(42);
  });

  it('preserves globalThis values and functions across executions', async () => {
    await expect(
      javaScriptTool.execute({
        code: `globalThis.secret = 41; globalThis.increment = value => value + 1; output(null)`,
      }),
    ).resolves.toBeNull();
    await expect(
      javaScriptTool.execute({
        code: `output(globalThis.increment(globalThis.secret))`,
      }),
    ).resolves.toBe(42);
  });

  it('keeps top-level declarations execution-local', async () => {
    await javaScriptTool.execute({ code: `const local = 1; output(local)` });
    await expect(
      javaScriptTool.execute({ code: `output(typeof local)` }),
    ).resolves.toBe('undefined');
  });

  it('preserves exact names and supports parallel provider calls', async () => {
    const result = await javaScriptTool.execute({
      code: `output(await Promise.all([
        mcp['git.hub']['echo-value']({ value: 1 }),
        mcp.other.same({ value: 2 }),
        mcp['odd namespace']['slash/name']({ value: 3 }),
      ]))`,
    });
    expect(result).toMatchObject([
      { value: 1 },
      { reference: { namespace: 'other', name: 'same' } },
      { value: 3 },
    ]);
  });

  it('refreshes namespaces and rejects retained stale wrappers', async () => {
    await javaScriptTool.execute({
      code: `globalThis.stale = mcp['stale.namespace']['temporary-tool']; output(null)`,
    });
    provider.remove({
      namespace: 'stale.namespace',
      name: 'temporary-tool',
    });
    await expect(
      javaScriptTool.execute({
        code: `output({ current: typeof mcp['stale.namespace'], retained: typeof globalThis.stale })`,
      }),
    ).resolves.toEqual({ current: 'undefined', retained: 'function' });
    await expect(
      javaScriptTool.execute({ code: `output(await globalThis.stale({}))` }),
    ).rejects.toThrow(/unavailable/);
  });

  it('resets explicit state on demand', async () => {
    await javaScriptTool.execute({
      code: `globalThis.secret = 1; output(null)`,
    });
    await javaScriptTool.reset();
    await expect(
      javaScriptTool.execute({ code: `output(typeof globalThis.secret)` }),
    ).resolves.toBe('undefined');
  });

  it('isolates separate JavaScriptTool instances', async () => {
    const other = createJavaScriptTool({ logging, provider, workerUrl });
    await other.start();
    try {
      await javaScriptTool.execute({
        code: `globalThis.secret = 1; output(null)`,
      });
      await expect(
        other.execute({ code: `output(typeof globalThis.secret)` }),
      ).resolves.toBe('undefined');
    } finally {
      await other.close();
    }
  });

  it('serializes concurrent executions in FIFO order', async () => {
    await javaScriptTool.execute({
      code: `globalThis.order = []; output(null)`,
    });
    const first = javaScriptTool.execute({
      code: `globalThis.order.push(1); await mcp['git.hub'].wait({}); globalThis.order.push(2); output(globalThis.order)`,
    });
    const second = javaScriptTool.execute({
      code: `globalThis.order.push(3); output(globalThis.order)`,
    });
    await expect(first).resolves.toEqual([1, 2]);
    await expect(second).resolves.toEqual([1, 2, 3]);
  });

  it('does not run a queued execution aborted before it starts', async () => {
    const active = javaScriptTool.execute({
      code: `await mcp['git.hub'].wait({}); output(null)`,
    });
    const controller = new AbortController();
    const queued = javaScriptTool.execute({
      code: `globalThis.ran = true; output(null)`,
      signal: controller.signal,
    });
    controller.abort(new Error('cancelled'));
    await active;
    await expect(queued).rejects.toThrow(/cancelled/);
    await expect(
      javaScriptTool.execute({ code: `output(typeof globalThis.ran)` }),
    ).resolves.toBe('undefined');
  });

  it('recovers with an empty context after active cancellation', async () => {
    await javaScriptTool.execute({
      code: `globalThis.secret = 1; output(null)`,
    });
    const controller = new AbortController();
    const execution = javaScriptTool.execute({
      code: `await mcp['git.hub'].wait({}); output(null)`,
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort(new Error('cancelled'));
    await expect(execution).rejects.toThrow(/cancelled/);
    await expect(
      javaScriptTool.execute({ code: `output(typeof globalThis.secret)` }),
    ).resolves.toBe('undefined');
  });

  it('preserves state after ordinary guest and provider errors', async () => {
    await javaScriptTool.execute({
      code: `globalThis.secret = 1; output(null)`,
    });
    await expect(
      javaScriptTool.execute({ code: `throw new Error('guest failure')` }),
    ).rejects.toThrow(/guest failure/);
    await expect(
      javaScriptTool.execute({
        code: `output(await mcp['stale.namespace']['temporary-tool']({}))`,
      }),
    ).resolves.toEqual({});
    await expect(
      javaScriptTool.execute({ code: `output(globalThis.secret)` }),
    ).resolves.toBe(1);
  });

  describe('execution results', () => {
    it.each(['void 0', 'return undefined'])(
      'returns null without emissions for %s',
      async (code) => {
        await expect(javaScriptTool.execute({ code })).resolves.toBeNull();
      },
    );

    it('returns one output directly', async () => {
      await expect(javaScriptTool.execute({ code: 'output(1)' })).resolves.toBe(
        1,
      );
    });

    it('aggregates multiple outputs in order', async () => {
      await expect(
        javaScriptTool.execute({
          code: `output('first'); output({ second: true })`,
        }),
      ).resolves.toEqual(['first', { second: true }]);
    });

    it('treats a return value as the final emission', async () => {
      await expect(
        javaScriptTool.execute({ code: 'return { value: 1 }' }),
      ).resolves.toEqual({ value: 1 });
      await expect(
        javaScriptTool.execute({
          code: `output('starting'); return { done: true }`,
        }),
      ).resolves.toEqual(['starting', { done: true }]);
      await expect(
        javaScriptTool.execute({ code: 'return null' }),
      ).resolves.toBeNull();
    });

    it('supports async return values after provider calls', async () => {
      await expect(
        javaScriptTool.execute({
          code: `return await mcp['git.hub']['echo-value']({ returned: true })`,
        }),
      ).resolves.toEqual({ returned: true });
    });

    it.each([
      'output(undefined)',
      'return () => undefined',
      'return 1n',
      'return Infinity',
      `const value = {}; value.self = value; return value`,
    ])('rejects non-JSON result values from %s', async (code) => {
      await expect(javaScriptTool.execute({ code })).rejects.toThrow();
    });

    it('enforces the byte limit across aggregated emissions', async () => {
      await expect(
        javaScriptTool.execute({
          code: `output('x'.repeat(140_000)); output('x'.repeat(140_000))`,
        }),
      ).rejects.toThrow(/Output exceeds/);
    });

    it('discards partial emissions when execution fails', async () => {
      await expect(
        javaScriptTool.execute({
          code: `output('partial'); throw new Error('failed')`,
        }),
      ).rejects.toThrow(/failed/);
      await expect(javaScriptTool.execute({ code: 'return 3' })).resolves.toBe(
        3,
      );
    });
  });

  it('does not expose ambient Node authority', async () => {
    await expect(
      javaScriptTool.execute({
        code: `output({ process: typeof process, require: typeof require })`,
      }),
    ).resolves.toEqual({ process: 'undefined', require: 'undefined' });
  });
});
