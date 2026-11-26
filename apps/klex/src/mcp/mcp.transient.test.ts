import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type CallToolResult,
  SdkErrorCode,
  SdkHttpError,
} from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RootLogger } from '@stagewise/logger';

import type { Config, ConfigListener, McpServerConfig } from '@/config';

import type {
  ConnectMcpServerOptions,
  McpConnection,
  McpConnectionFactory,
} from './connection';
import { createMcp, type Mcp } from './mcp';
import { McpServerStartingError } from './transient-errors';

const modules: Mcp[] = [];
const servers: Record<string, McpServerConfig> = {
  computer: { url: 'https://computer.example/mcp' },
};
const reference = { namespace: 'computer', name: 'run' };
const toolContext = {
  executionId: 'test',
  signal: new AbortController().signal,
};
const ok: CallToolResult = { content: [{ type: 'text', text: 'done' }] };

afterEach(async () => {
  await Promise.all(modules.splice(0).map((mcp) => mcp.close()));
  vi.useRealTimers();
});

function refusal(
  status: number,
  code: string,
  message: string,
  retryAfterSeconds?: number,
): SdkHttpError {
  const text = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    error: { code: -32000, message, data: { code, retryAfterSeconds } },
  });
  return new SdkHttpError(
    SdkErrorCode.ClientHttpNotImplemented,
    `Error POSTing to endpoint: ${text}`,
    { status, text },
  );
}

const starting = () =>
  refusal(
    503,
    'machine_starting',
    'Computer is starting; retry in 5 seconds',
    5,
  );

function connection(invoke = vi.fn()): McpConnection & {
  invoke: ReturnType<typeof vi.fn>;
} {
  return {
    namespace: 'computer',
    metadata: {},
    tools: [{ name: 'run', inputSchema: { type: 'object', properties: {} } }],
    supportsPushNotifications: false,
    pushNotifications: {},
    supportsRealtimeMedia: false,
    realtimeMedia: {},
    supportsResourceSubscription: false,
    listResources: async () => ({ resources: [] }),
    listResourceTemplates: async () => ({ resourceTemplates: [] }),
    invoke,
    close: vi.fn(async () => undefined),
  } as unknown as McpConnection & { invoke: ReturnType<typeof vi.fn> };
}

function setup(connect: McpConnectionFactory) {
  const config = {
    get: () => ({ mcpServers: servers }),
    getMcpServers: () => servers,
    resolveEnvironment: <T>(value: T) => value,
    subscribe: (_listener: ConfigListener) => () => undefined,
  } as unknown as Config;
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const mcp = createMcp({
    config,
    logging: { child: () => logger } as unknown as RootLogger,
    dataDirectory: join(tmpdir(), 'klex-mcp-transient'),
    connect,
  });
  modules.push(mcp);
  return mcp;
}

async function namespaces(mcp: Mcp): Promise<string[]> {
  return (await mcp.snapshot(toolContext)).namespaces.map(({ name }) => name);
}

function settle<T>(promise: Promise<T>) {
  const state: { value?: T; error?: unknown; done: boolean } = { done: false };
  promise.then(
    (value) => Object.assign(state, { value, done: true }),
    (error: unknown) => Object.assign(state, { error, done: true }),
  );
  return state;
}

describe('MCP transient tool call failures', () => {
  it('retries a starting computer after the server-suggested delay', async () => {
    vi.useFakeTimers();
    const live = connection(
      vi.fn().mockRejectedValueOnce(starting()).mockResolvedValueOnce(ok),
    );
    const mcp = setup(async () => live);
    await mcp.start();
    await vi.advanceTimersByTimeAsync(0);

    const call = settle(mcp.invoke(reference, {}, toolContext));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(live.invoke).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(call).toMatchObject({ done: true, value: ok });
    expect(live.invoke).toHaveBeenCalledTimes(2);
    expect(mcp.getToolCallHistory()[0]).toMatchObject({ isError: false });
  });

  it('reports a still-starting computer as temporary after bounded retries', async () => {
    vi.useFakeTimers();
    const live = connection(
      vi
        .fn()
        .mockRejectedValue(
          refusal(
            503,
            'billing_authorization_failed',
            'Managed computer billing authorization failed',
            5,
          ),
        ),
    );
    const mcp = setup(async () => live);
    await mcp.start();
    await vi.advanceTimersByTimeAsync(0);

    const call = settle(mcp.invoke(reference, {}, toolContext));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(live.invoke).toHaveBeenCalledTimes(4);
    expect(call.error).toBeInstanceOf(McpServerStartingError);
    const message = (call.error as Error).message;
    expect(message).toContain('temporarily unavailable');
    expect(message).toContain('Klex retried for 15 s');
    expect(message).not.toMatch(/billing authorization/i);
    expect(mcp.getToolCallHistory()[0]).toMatchObject({
      isError: true,
      result: { error: message },
    });
  });

  it('keeps a non-retryable denial final', async () => {
    const denial = refusal(
      409,
      'machine_billing_suspended',
      'Managed computer billing authorization is unavailable or changed',
    );
    const live = connection(vi.fn().mockRejectedValue(denial));
    const mcp = setup(async () => live);
    await mcp.start();
    await vi.waitFor(async () =>
      expect(await namespaces(mcp)).toEqual(['computer']),
    );

    await expect(mcp.invoke(reference, {}, toolContext)).rejects.toBe(denial);
    expect(live.invoke).toHaveBeenCalledTimes(1);
  });

  it('stops waiting when the caller aborts', async () => {
    vi.useFakeTimers();
    const live = connection(vi.fn().mockRejectedValue(starting()));
    const mcp = setup(async () => live);
    await mcp.start();
    await vi.advanceTimersByTimeAsync(0);

    const controller = new AbortController();
    const call = settle(
      mcp.invoke(reference, {}, { ...toolContext, signal: controller.signal }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort(new Error('turn cancelled'));
    await vi.advanceTimersByTimeAsync(0);
    expect(call.error).toEqual(new Error('turn cancelled'));
    expect(live.invoke).toHaveBeenCalledTimes(1);
  });
});

describe('MCP transient reconnects', () => {
  it('keeps tools registered while a disconnected computer starts, then calls the new connection', async () => {
    vi.useFakeTimers();
    const first = connection();
    const second = connection(vi.fn().mockResolvedValue(ok));
    let options: ConnectMcpServerOptions | undefined;
    const connect = vi
      .fn<McpConnectionFactory>()
      .mockImplementationOnce(async (next) => {
        options = next;
        return first;
      })
      .mockRejectedValueOnce(starting())
      .mockResolvedValueOnce(second);
    const mcp = setup(connect);
    await mcp.start();
    await vi.advanceTimersByTimeAsync(0);
    options?.onDisconnect(first);
    expect(await namespaces(mcp)).toEqual(['computer']);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(await namespaces(mcp)).toEqual(['computer']);
    expect(mcp.getServerStatuses()[0]).toMatchObject({
      status: 'error',
      lastError: {
        name: 'McpServerStartingError',
        message:
          'The computer is starting or temporarily unavailable; retrying',
      },
    });

    const call = settle(mcp.invoke(reference, {}, toolContext));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(call.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(connect).toHaveBeenCalledTimes(3);
    expect(call).toMatchObject({ done: true, value: ok });
    expect(first.invoke).not.toHaveBeenCalled();
    expect(second.invoke).toHaveBeenCalledTimes(1);
  });

  it('drops retained tools when a reconnect fails for a non-transient reason', async () => {
    vi.useFakeTimers();
    const first = connection();
    let options: ConnectMcpServerOptions | undefined;
    const connect = vi
      .fn<McpConnectionFactory>()
      .mockImplementationOnce(async (next) => {
        options = next;
        return first;
      })
      .mockRejectedValue(new Error('certificate rejected'));
    const mcp = setup(connect);
    await mcp.start();
    await vi.advanceTimersByTimeAsync(0);
    options?.onDisconnect(first);
    expect(await namespaces(mcp)).toEqual(['computer']);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(await namespaces(mcp)).toEqual([]);
    await expect(mcp.invoke(reference, {}, toolContext)).rejects.toThrow(
      'Unknown MCP tool: computer.run',
    );
  });

  it('does not retain tools after a post-connect authorization failure', async () => {
    vi.useFakeTimers();
    const first = connection();
    let options: ConnectMcpServerOptions | undefined;
    const mcp = setup(async (next) => {
      options = next;
      return first;
    });
    await mcp.start();
    await vi.advanceTimersByTimeAsync(0);
    options?.onDisconnect(first, 'unauthorized');
    expect(await namespaces(mcp)).toEqual([]);
  });

  it('retries a starting initialize at the hinted interval instead of backing off', async () => {
    vi.useFakeTimers();
    const connect = vi.fn<McpConnectionFactory>().mockRejectedValue(starting());
    const mcp = setup(connect);
    await mcp.start();
    await vi.advanceTimersByTimeAsync(0);
    for (let attempt = 2; attempt <= 6; attempt++) {
      await vi.advanceTimersByTimeAsync(5_000);
      expect(connect).toHaveBeenCalledTimes(attempt);
    }
  });

  it('stops retaining tools once a transient outage outlasts the retention window', async () => {
    vi.useFakeTimers();
    const first = connection();
    let options: ConnectMcpServerOptions | undefined;
    const connect = vi
      .fn<McpConnectionFactory>()
      .mockImplementationOnce(async (next) => {
        options = next;
        return first;
      })
      .mockRejectedValue(starting());
    const mcp = setup(connect);
    await mcp.start();
    await vi.advanceTimersByTimeAsync(0);
    options?.onDisconnect(first);

    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(await namespaces(mcp)).toEqual(['computer']);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(await namespaces(mcp)).toEqual([]);
  });
});
