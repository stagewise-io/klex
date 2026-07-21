import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ModuleLogger, RootLogger } from '@stagewise/logger';

import { InMemoryCapabilityProvider } from './in-memory-provider.fixture';
import { createToolbox, type Toolbox } from './toolbox';

const logging = {
  child: () => ({ info: () => undefined }) as unknown as ModuleLogger,
} as unknown as RootLogger;
const workerUrl = new URL('../../dist/toolbox-worker.js', import.meta.url);

describe('Toolbox', () => {
  let toolbox: Toolbox;
  let provider: InMemoryCapabilityProvider;

  beforeEach(async () => {
    provider = new InMemoryCapabilityProvider();
    toolbox = createToolbox({ logging, provider, workerUrl });
    await toolbox.start();
  });

  afterEach(async () => {
    await toolbox.close();
  });

  it('preserves globalThis values and functions across executions', async () => {
    await expect(
      toolbox.execute({
        code: `globalThis.secret = 41; globalThis.increment = value => value + 1; output(null)`,
      }),
    ).resolves.toBeNull();
    await expect(
      toolbox.execute({
        code: `output(globalThis.increment(globalThis.secret))`,
      }),
    ).resolves.toBe(42);
  });

  it('keeps top-level declarations execution-local', async () => {
    await toolbox.execute({ code: `const local = 1; output(local)` });
    await expect(
      toolbox.execute({ code: `output(typeof local)` }),
    ).resolves.toBe('undefined');
  });

  it('preserves exact names and supports parallel provider calls', async () => {
    const result = await toolbox.execute({
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
    await toolbox.execute({
      code: `globalThis.stale = mcp['stale.namespace']['temporary-tool']; output(null)`,
    });
    provider.remove({
      namespace: 'stale.namespace',
      name: 'temporary-tool',
    });
    await expect(
      toolbox.execute({
        code: `output({ current: typeof mcp['stale.namespace'], retained: typeof globalThis.stale })`,
      }),
    ).resolves.toEqual({ current: 'undefined', retained: 'function' });
    await expect(
      toolbox.execute({ code: `output(await globalThis.stale({}))` }),
    ).rejects.toThrow(/unavailable/);
  });

  it('resets explicit state on demand', async () => {
    await toolbox.execute({ code: `globalThis.secret = 1; output(null)` });
    await toolbox.reset();
    await expect(
      toolbox.execute({ code: `output(typeof globalThis.secret)` }),
    ).resolves.toBe('undefined');
  });

  it('isolates separate Toolbox instances', async () => {
    const other = createToolbox({ logging, provider, workerUrl });
    await other.start();
    try {
      await toolbox.execute({ code: `globalThis.secret = 1; output(null)` });
      await expect(
        other.execute({ code: `output(typeof globalThis.secret)` }),
      ).resolves.toBe('undefined');
    } finally {
      await other.close();
    }
  });

  it('serializes concurrent executions in FIFO order', async () => {
    await toolbox.execute({ code: `globalThis.order = []; output(null)` });
    const first = toolbox.execute({
      code: `globalThis.order.push(1); await mcp['git.hub'].wait({}); globalThis.order.push(2); output(globalThis.order)`,
    });
    const second = toolbox.execute({
      code: `globalThis.order.push(3); output(globalThis.order)`,
    });
    await expect(first).resolves.toEqual([1, 2]);
    await expect(second).resolves.toEqual([1, 2, 3]);
  });

  it('does not run a queued execution aborted before it starts', async () => {
    const active = toolbox.execute({
      code: `await mcp['git.hub'].wait({}); output(null)`,
    });
    const controller = new AbortController();
    const queued = toolbox.execute({
      code: `globalThis.ran = true; output(null)`,
      signal: controller.signal,
    });
    controller.abort(new Error('cancelled'));
    await active;
    await expect(queued).rejects.toThrow(/cancelled/);
    await expect(
      toolbox.execute({ code: `output(typeof globalThis.ran)` }),
    ).resolves.toBe('undefined');
  });

  it('recovers with an empty context after active cancellation', async () => {
    await toolbox.execute({ code: `globalThis.secret = 1; output(null)` });
    const controller = new AbortController();
    const execution = toolbox.execute({
      code: `await mcp['git.hub'].wait({}); output(null)`,
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort(new Error('cancelled'));
    await expect(execution).rejects.toThrow(/cancelled/);
    await expect(
      toolbox.execute({ code: `output(typeof globalThis.secret)` }),
    ).resolves.toBe('undefined');
  });

  it('preserves state after ordinary guest and provider errors', async () => {
    await toolbox.execute({ code: `globalThis.secret = 1; output(null)` });
    await expect(
      toolbox.execute({ code: `throw new Error('guest failure')` }),
    ).rejects.toThrow(/guest failure/);
    await expect(
      toolbox.execute({
        code: `output(await mcp['stale.namespace']['temporary-tool']({}))`,
      }),
    ).resolves.toEqual({});
    await expect(
      toolbox.execute({ code: `output(globalThis.secret)` }),
    ).resolves.toBe(1);
  });

  it('resets exactly-once output tracking between calls', async () => {
    await expect(toolbox.execute({ code: 'void 0' })).rejects.toThrow(
      /exactly once/,
    );
    await expect(
      toolbox.execute({ code: 'output(1); output(2)' }),
    ).rejects.toThrow(/exactly once/);
    await expect(toolbox.execute({ code: 'output(3)' })).resolves.toBe(3);
  });

  it('does not expose ambient Node authority', async () => {
    await expect(
      toolbox.execute({
        code: `output({ process: typeof process, require: typeof require })`,
      }),
    ).resolves.toEqual({ process: 'undefined', require: 'undefined' });
  });
});
