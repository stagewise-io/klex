import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleLogger, RootLogger } from '@stagewise/logger';

import { InMemoryToolProvider } from './in-memory-tool-provider.fixture';
import { createJavaScriptTool, type JavaScriptTool } from './javascript';

const logging = {
  child: () => ({ info: () => undefined }) as unknown as ModuleLogger,
} as unknown as RootLogger;
const workerUrl = new URL(
  '../../../../../dist/javascript-sandbox-worker.js',
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

  it('exposes only runInSandbox and delegates execution', async () => {
    expect(Object.keys(javaScriptTool.tools)).toEqual(['runInSandbox']);
    const runInSandbox = javaScriptTool.tools.runInSandbox;
    expect(runInSandbox).toBeDefined();
    const execute = runInSandbox?.execute as
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

  it('advertises schema-inclusive discovery in both model-facing descriptions', () => {
    const prompt = readFileSync(
      new URL('./system-prompt-part.md', import.meta.url),
      'utf8',
    );
    const description = javaScriptTool.tools.runInSandbox?.description;
    for (const text of [prompt, description]) {
      expect(text).toContain('includeInputSchema: true');
      expect(text).toContain('"deployment", { limit: 5');
      expect(text).toContain('tools.describe({ namespace, name })');
      expect(text).toContain('maximum 20');
    }
  });

  it('returns schemas through the real worker and invokes without describe', async () => {
    const matches = await javaScriptTool.execute({
      code: `globalThis.matches = await tools.search('echo', { includeInputSchema: true, limit: 1 }); return globalThis.matches;`,
    });
    expect(matches).toEqual([
      {
        reference: { namespace: 'git.hub', name: 'echo-value' },
        description: 'Echoes its input',
        inputSchema: {
          type: 'object',
          properties: {
            value: { type: 'number', description: 'Value to echo' },
          },
          required: ['value'],
          additionalProperties: false,
        },
      },
    ]);
    expect(provider.searches).toEqual([
      { query: 'echo', options: { includeInputSchema: true, limit: 1 } },
    ]);
    await expect(
      javaScriptTool.execute({
        code: `const { namespace, name } = globalThis.matches[0].reference; return await mcp[namespace][name]({ value: 42 });`,
      }),
    ).resolves.toEqual({ value: 42 });
    expect(provider.invoked).toEqual([
      { namespace: 'git.hub', name: 'echo-value' },
    ]);
    expect(provider.described).toEqual([]);
  });

  it('keeps compact results, supports false, and omits unavailable schemas', async () => {
    const expected = [
      {
        reference: { namespace: 'git.hub', name: 'echo-value' },
        description: 'Echoes its input',
      },
    ];
    for (const options of ['', ', { includeInputSchema: false }']) {
      await expect(
        javaScriptTool.execute({
          code: `return await tools.search('echo'${options})`,
        }),
      ).resolves.toEqual(expected);
    }
    await expect(
      javaScriptTool.execute({
        code: `return await tools.search('asynchronously', { includeInputSchema: true })`,
      }),
    ).resolves.toEqual([
      {
        reference: { namespace: 'git.hub', name: 'wait' },
        description: 'Resolves asynchronously',
      },
    ]);
    const rich = await javaScriptTool.execute({
      code: `return await tools.search('echo', { includeInputSchema: true })`,
    });
    const details = await javaScriptTool.execute({
      code: `return await tools.describe({ namespace: 'git.hub', name: 'echo-value' })`,
    });
    expect(rich).toEqual([details]);
  });

  it.each([
    { size: 1_048_576, error: /Provider response exceeds 1048576 bytes/ },
    { size: 262_144, error: /Output exceeds/ },
  ])(
    'keeps schema search byte limits for $size-byte schemas',
    async ({ size, error }) => {
      vi.spyOn(provider, 'search').mockResolvedValue([
        {
          reference: { namespace: 'git.hub', name: 'echo-value' },
          inputSchema: { type: 'object', description: 'x'.repeat(size) },
        },
      ]);
      await expect(
        javaScriptTool.execute({
          code: `return await tools.search('echo', { includeInputSchema: true })`,
        }),
      ).rejects.toThrow(error);
      expect(provider.invoked).toEqual([]);
    },
  );

  it.each([
    'tools.search()',
    'tools.search({ query: "deployment" })',
    'tools.search("")',
    'tools.search("deployment", null)',
    'tools.search("deployment", [])',
    'tools.search("deployment", 5)',
    'tools.search("deployment", { limit: 0 })',
    'tools.search("deployment", { limit: -1 })',
    'tools.search("deployment", { limit: 1.5 })',
    'tools.search("deployment", { limit: NaN })',
    'tools.search("deployment", { limit: Infinity })',
    'tools.search("deployment", { limit: "5" })',
    'tools.search("deployment", { includeInputSchema: "true" })',
    'tools.search("deployment", { includeInputSchema: null })',
    'tools.search("deployment", { includeInputSchema: true, limit: 21 })',
    'tools.describe("git.hub.echo-value")',
    'tools.describe({ namespace: "git.hub" })',
    'tools.describe({ namespace: "", name: "echo-value" })',
    'tools.describe({ namespace: "git.hub", name: " " })',
    'mcp["git.hub"]["echo-value"]()',
    'mcp["git.hub"]["echo-value"]([])',
    'mcp["git.hub"]["echo-value"](null)',
    'mcp["git.hub"]["echo-value"](Infinity)',
  ])(
    'explains malformed call without sending a provider request: %s',
    async (code) => {
      await javaScriptTool.execute({ code: 'globalThis.preserved = 42' });
      await expect(
        javaScriptTool.execute({ code: `return await ${code}` }),
      ).rejects.toThrow(/tools\.(search|describe)\(/);
      expect(provider.searches).toEqual([]);
      expect(provider.described).toEqual([]);
      expect(provider.invoked).toEqual([]);
      await expect(
        javaScriptTool.execute({ code: 'return globalThis.preserved' }),
      ).resolves.toBe(42);
    },
  );

  it('preserves globalThis values and functions across executions', async () => {
    await expect(
      javaScriptTool.execute({
        code: `globalThis.secret = 41; globalThis.increment = value => value + 1`,
      }),
    ).resolves.toBeNull();
    await expect(
      javaScriptTool.execute({
        code: `return globalThis.increment(globalThis.secret)`,
      }),
    ).resolves.toBe(42);
  });

  it('keeps top-level declarations execution-local', async () => {
    await javaScriptTool.execute({ code: `const local = 1; return local` });
    await expect(
      javaScriptTool.execute({ code: `return typeof local` }),
    ).resolves.toBe('undefined');
  });

  it('preserves exact names and supports parallel provider calls', async () => {
    const result = await javaScriptTool.execute({
      code: `return await Promise.all([
        mcp['git.hub']['echo-value']({ value: 1 }),
        mcp.other.same({ value: 2 }),
        mcp['odd namespace']['slash/name']({ value: 3 }),
      ])`,
    });
    expect(result).toMatchObject([
      { value: 1 },
      { reference: { namespace: 'other', name: 'same' } },
      { value: 3 },
    ]);
  });

  it('refreshes namespaces and rejects retained stale wrappers', async () => {
    await javaScriptTool.execute({
      code: `globalThis.stale = mcp['stale.namespace']['temporary-tool']`,
    });
    provider.remove({
      namespace: 'stale.namespace',
      name: 'temporary-tool',
    });
    await expect(
      javaScriptTool.execute({
        code: `return { current: typeof mcp['stale.namespace'], retained: typeof globalThis.stale }`,
      }),
    ).resolves.toEqual({ current: 'undefined', retained: 'function' });
    await expect(
      javaScriptTool.execute({ code: `return await globalThis.stale({})` }),
    ).rejects.toThrow(/unavailable/);
  });

  it('resets explicit state on demand', async () => {
    await javaScriptTool.execute({
      code: `globalThis.secret = 1`,
    });
    await javaScriptTool.reset();
    await expect(
      javaScriptTool.execute({ code: `return typeof globalThis.secret` }),
    ).resolves.toBe('undefined');
  });

  it('isolates separate JavaScriptTool instances', async () => {
    const other = createJavaScriptTool({ logging, provider, workerUrl });
    await other.start();
    try {
      await javaScriptTool.execute({
        code: `globalThis.secret = 1`,
      });
      await expect(
        other.execute({ code: `return typeof globalThis.secret` }),
      ).resolves.toBe('undefined');
    } finally {
      await other.close();
    }
  });

  it('serializes concurrent executions in FIFO order', async () => {
    await javaScriptTool.execute({
      code: `globalThis.order = []`,
    });
    const first = javaScriptTool.execute({
      code: `globalThis.order.push(1); await mcp['git.hub'].wait({}); globalThis.order.push(2); return globalThis.order`,
    });
    const second = javaScriptTool.execute({
      code: `globalThis.order.push(3); return globalThis.order`,
    });
    await expect(first).resolves.toEqual([1, 2]);
    await expect(second).resolves.toEqual([1, 2, 3]);
  });

  it('does not run a queued execution aborted before it starts', async () => {
    const active = javaScriptTool.execute({
      code: `await mcp['git.hub'].wait({})`,
    });
    const controller = new AbortController();
    const queued = javaScriptTool.execute({
      code: `globalThis.ran = true`,
      signal: controller.signal,
    });
    controller.abort(new Error('cancelled'));
    await active;
    await expect(queued).rejects.toThrow(/cancelled/);
    await expect(
      javaScriptTool.execute({ code: `return typeof globalThis.ran` }),
    ).resolves.toBe('undefined');
  });

  it('recovers with an empty context after active cancellation', async () => {
    await javaScriptTool.execute({
      code: `globalThis.secret = 1`,
    });
    const controller = new AbortController();
    const execution = javaScriptTool.execute({
      code: `await mcp['git.hub'].wait({})`,
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort(new Error('cancelled'));
    await expect(execution).rejects.toThrow(/cancelled/);
    await expect(
      javaScriptTool.execute({ code: `return typeof globalThis.secret` }),
    ).resolves.toBe('undefined');
  });

  it('preserves state after ordinary guest and provider errors', async () => {
    await javaScriptTool.execute({
      code: `globalThis.secret = 1`,
    });
    await expect(
      javaScriptTool.execute({ code: `throw new Error('guest failure')` }),
    ).rejects.toThrow(/guest failure/);
    await expect(
      javaScriptTool.execute({
        code: `return await mcp['stale.namespace']['temporary-tool']({})`,
      }),
    ).resolves.toEqual({});
    await expect(
      javaScriptTool.execute({ code: `return globalThis.secret` }),
    ).resolves.toBe(1);
  });

  describe('execution results', () => {
    it.each(['void 0', 'return undefined'])(
      'returns null without emissions for %s',
      async (code) => {
        await expect(javaScriptTool.execute({ code })).resolves.toBeNull();
      },
    );

    it('removes output and exposes a frozen console API', async () => {
      await expect(
        javaScriptTool.execute({
          code: `return {
            output: typeof output,
            consoleFrozen: Object.isFrozen(console),
            logFrozen: Object.isFrozen(console.log),
            logType: typeof console.log,
          }`,
        }),
      ).resolves.toEqual({
        output: 'undefined',
        consoleFrozen: true,
        logFrozen: true,
        logType: 'function',
      });
    });

    it('captures zero and variadic console arguments', async () => {
      await expect(
        javaScriptTool.execute({
          code: `console.log(); console.log('value', 1, true)`,
        }),
      ).resolves.toEqual(['', 'value 1 true']);
    });

    it('captures one console line directly', async () => {
      await expect(
        javaScriptTool.execute({ code: `console.log('value', 1)` }),
      ).resolves.toBe('value 1');
    });

    it('aggregates console lines in order', async () => {
      await expect(
        javaScriptTool.execute({
          code: `console.log('first'); console.log({ second: true })`,
        }),
      ).resolves.toEqual(['first', '{ second: true }']);
    });

    it('formats placeholders and preserves unused arguments', async () => {
      await expect(
        javaScriptTool.execute({
          code: `console.log('text=%s int=%i float=%f object=%o %%', 'x', '12.9', '2.5', { ok: true }, 'tail')`,
        }),
      ).resolves.toBe('text=x int=12 float=2.5 object={ ok: true } % tail');
    });

    it('renders arbitrary JavaScript values as text', async () => {
      await expect(
        javaScriptTool.execute({
          code: `console.log(undefined, 1n, Symbol('x'), function demo() {}, new Error('boom'), NaN, Infinity, [1, 'x'], { ok: true })`,
        }),
      ).resolves.toBe(
        `undefined 1n Symbol(x) [Function: demo] Error: boom NaN Infinity [ 1, "x" ] { ok: true }`,
      );
    });

    it('bounds inspection, marks cycles, and does not invoke getters', async () => {
      await expect(
        javaScriptTool.execute({
          code: `
            let getterCalls = 0;
            const accessor = {};
            Object.defineProperty(accessor, 'value', { enumerable: true, get() { getterCalls += 1; return 1; } });
            const cyclic = {}; cyclic.self = cyclic;
            const deep = { a: { b: { c: { d: { e: 1 } } } } };
            console.log(accessor, cyclic, deep, Array.from({ length: 51 }, (_, index) => index));
            return getterCalls;
          `,
        }),
      ).resolves.toEqual([
        `{ value: [Getter] } { self: [Circular] } { a: { b: { c: { d: [Object] } } } } [ ${Array.from(
          { length: 50 },
          (_, index) => index,
        ).join(', ')}, ... 1 more items ]`,
        0,
      ]);
    });

    it('contains inspection failures in the captured line', async () => {
      await expect(
        javaScriptTool.execute({
          code: `console.log(new Proxy({}, { ownKeys() { throw new Error('nope'); } }))`,
        }),
      ).resolves.toBe('[Uninspectable: nope]');
    });

    it('treats a return value as the final emission', async () => {
      await expect(
        javaScriptTool.execute({ code: 'return { value: 1 }' }),
      ).resolves.toEqual({ value: 1 });
      await expect(
        javaScriptTool.execute({
          code: `console.log('starting'); return { done: true }`,
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
          code: `console.log('x'.repeat(140_000)); console.log('x'.repeat(140_000))`,
        }),
      ).rejects.toThrow(/Output exceeds/);
    });

    it('discards partial emissions when execution fails', async () => {
      await expect(
        javaScriptTool.execute({
          code: `console.log('partial'); throw new Error('failed')`,
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
        code: `return { process: typeof process, require: typeof require }`,
      }),
    ).resolves.toEqual({ process: 'undefined', require: 'undefined' });
  });
});
