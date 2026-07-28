import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RootLogger } from '@stagewise/logger';

import type { Config, McpServerConfig } from '@/config';
import { createInMemoryFluidEventInbox } from '@/fluid-event-inbox';

import type {
  ConnectMcpServerOptions,
  McpConnection,
  McpConnectionFactory,
} from './connection';
import { createMcp } from './mcp';

const logging = {
  child: () => ({
    debug: () => undefined,
    error: () => undefined,
    info: () => undefined,
    warn: () => undefined,
  }),
} as unknown as RootLogger;

afterEach(() => {
  vi.useRealTimers();
});

function createConfig(servers: Record<string, McpServerConfig>): Config {
  return {
    getMcpServers: () => servers,
    subscribe: () => () => undefined,
  } as unknown as Config;
}

function connection(namespace: string): McpConnection {
  return {
    namespace,
    tools: [
      {
        name: 'echo',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
    supportsFluidEvents: false,
    fluidEvents: {},
    invoke: vi.fn(),
    close: vi.fn(async () => undefined),
  } as unknown as McpConnection;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function setup(
  servers: Record<string, McpServerConfig>,
  connect: McpConnectionFactory,
) {
  return createMcp({
    logging,
    config: createConfig(servers),
    fluidEventInbox: createInMemoryFluidEventInbox(),
    connect,
  });
}

async function waitForNamespace(
  mcp: ReturnType<typeof createMcp>,
  namespace: string,
): Promise<void> {
  await vi.waitFor(async () => {
    const snapshot = await mcp.snapshot({
      executionId: 'test',
      signal: new AbortController().signal,
    });
    expect(snapshot.namespaces.map(({ name }) => name)).toContain(namespace);
  });
}

describe('MCP Fluid Event subscriptions', () => {
  it('registers listeners and returns an idempotent unsubscribe function', async () => {
    const mcp = setup({}, async () => connection('unused'));
    const listener = vi.fn();

    const unsubscribe = mcp.onFluidEvent(listener);
    unsubscribe();
    unsubscribe();

    await mcp.start();
    await mcp.close();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('MCP startup isolation', () => {
  it('starts immediately and publishes a healthy namespace independently', async () => {
    const pending = deferred<McpConnection>();
    const mcp = setup(
      {
        hanging: { url: 'https://hanging.example/mcp' },
        healthy: { url: 'https://healthy.example/mcp' },
      },
      async ({ namespace }) =>
        namespace === 'hanging' ? pending.promise : connection(namespace),
    );

    await mcp.start();
    await waitForNamespace(mcp, 'healthy');
    const snapshot = await mcp.snapshot({
      executionId: 'test',
      signal: new AbortController().signal,
    });
    expect(snapshot.namespaces.map(({ name }) => name)).toEqual(['healthy']);
    await mcp.close();
  });

  it('keeps healthy namespaces while failed namespaces retry independently', async () => {
    vi.useFakeTimers();
    const attempts = new Map<string, number>();
    const connect = vi.fn(async ({ namespace }: ConnectMcpServerOptions) => {
      attempts.set(namespace, (attempts.get(namespace) ?? 0) + 1);
      if (namespace === 'failing') throw new Error('offline');
      return connection(namespace);
    });
    const mcp = setup(
      {
        failing: { url: 'https://failing.example/mcp' },
        healthy: { url: 'https://healthy.example/mcp' },
      },
      connect,
    );

    await mcp.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts.get('healthy')).toBe(1);
    expect(attempts.get('failing')).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(attempts.get('healthy')).toBe(1);
    expect(attempts.get('failing')).toBe(2);
    const snapshot = await mcp.snapshot({
      executionId: 'test',
      signal: new AbortController().signal,
    });
    expect(snapshot.namespaces.map(({ name }) => name)).toEqual(['healthy']);
    await mcp.close();
  });

  it('closes a connection that resolves after non-blocking shutdown', async () => {
    const pending = deferred<McpConnection>();
    const late = connection('late');
    const connect = vi.fn(async () => pending.promise);
    const mcp = setup({ late: { url: 'https://late.example/mcp' } }, connect);

    await mcp.start();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    await mcp.close();
    pending.resolve(late);
    await vi.waitFor(() => expect(late.close).toHaveBeenCalledOnce());
    const snapshot = await mcp.snapshot({
      executionId: 'test',
      signal: new AbortController().signal,
    });
    expect(snapshot.namespaces).toEqual([]);
  });
});
