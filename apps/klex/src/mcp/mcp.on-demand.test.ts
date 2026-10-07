import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { RootLogger } from '@stagewise/logger';

import type {
  Config,
  ConfigListener,
  KlexConfig,
  McpServerConfig,
} from '@/config';

import {
  type ConnectMcpServerOptions,
  McpAuthorizationRequiredError,
  type McpConnection,
  type McpConnectionFactory,
} from './connection';
import { createMcp, type Mcp } from './mcp';

const logging = {
  child: () => ({
    debug: () => undefined,
    error: () => undefined,
    info: () => undefined,
    warn: () => undefined,
  }),
} as unknown as RootLogger;

const catalogUrl = 'https://cloud.example/api/machines/m1/lifecycle';
const machine: McpServerConfig = {
  url: 'https://cloud.example/machines/m1/mcp',
  headers: { Authorization: 'Bearer machine-token' },
  lifecycle: { mode: 'on-demand', catalogUrl },
};

const toolContext = {
  executionId: 'test',
  signal: new AbortController().signal,
};

const echoTool = {
  name: 'echo',
  description: 'Echo input',
  inputSchema: { type: 'object' as const, properties: {} },
};

function catalogBody(tools: unknown[] = [echoTool], generation = 3) {
  return {
    version: 1,
    generation,
    catalogStatus: 'ready',
    catalog: { version: '1', tools, resources: [], resourceTemplates: [] },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function liveConnection(tools = [echoTool]): McpConnection {
  return {
    namespace: 'machine',
    tools,
    supportsPushNotifications: false,
    pushNotifications: {},
    supportsRealtimeMedia: false,
    realtimeMedia: {},
    supportsResourceSubscription: false,
    invoke: vi.fn(async () => ({
      content: [{ type: 'text', text: 'ok' }],
    })),
    close: vi.fn(async () => undefined),
  } as unknown as McpConnection;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function setup(options: {
  connect: McpConnectionFactory;
  catalog?: () => Response | Promise<Response>;
  servers?: Record<string, McpServerConfig>;
}) {
  let servers = structuredClone(options.servers ?? { machine });
  let listener: ConfigListener | undefined;
  const config = {
    getMcpServers: () => servers,
    subscribe: (next: ConfigListener) => {
      listener = next;
      return () => {
        if (listener === next) listener = undefined;
      };
    },
  } as unknown as Config;
  const catalogFetch = vi.fn<typeof fetch>(async () =>
    options.catalog ? options.catalog() : jsonResponse(catalogBody()),
  );
  const mcp = createMcp({
    logging,
    config,
    dataDirectory: join(tmpdir(), 'klex-mcp-on-demand-test'),
    connect: options.connect,
    fetch: catalogFetch,
  });
  return {
    mcp,
    catalogFetch,
    async publish(next: Record<string, McpServerConfig>) {
      servers = structuredClone(next);
      await listener?.({ mcpServers: servers } as unknown as KlexConfig);
    },
  };
}

function statusOf(mcp: Mcp, name = 'machine') {
  return mcp.getServerStatuses().find((server) => server.name === name);
}

async function toolNames(mcp: Mcp): Promise<string[]> {
  const snapshot = await mcp.snapshot(toolContext);
  return snapshot.namespaces.flatMap((namespace) =>
    namespace.capabilities.map(({ name }) => `${namespace.name}.${name}`),
  );
}

async function waitForStandby(mcp: Mcp): Promise<void> {
  await vi.waitFor(() => expect(statusOf(mcp)?.status).toBe('standby'));
}

const echo = { namespace: 'machine', name: 'echo' };

describe('on-demand MCP servers', () => {
  it('lists catalog tools in standby without opening a connection', async () => {
    const connect = vi.fn<McpConnectionFactory>();
    const { mcp, catalogFetch } = setup({ connect });

    await mcp.start();
    await waitForStandby(mcp);

    expect(connect).not.toHaveBeenCalled();
    expect(catalogFetch).toHaveBeenCalledWith(catalogUrl, expect.anything());
    const init = catalogFetch.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get('authorization')).toBe(
      'Bearer machine-token',
    );
    expect(await toolNames(mcp)).toEqual(['machine.echo']);
    expect(statusOf(mcp)?.toolCount).toBe(1);
    const description = await mcp.describe(echo, toolContext);
    expect(description.reference).toEqual(echo);
    await mcp.close();
  });

  it('shares one demand activation between concurrent calls and dispatches each once', async () => {
    const live = liveConnection();
    const opened = deferred<McpConnection>();
    const connect = vi.fn<McpConnectionFactory>(() => opened.promise);
    const { mcp } = setup({ connect });
    await mcp.start();
    await waitForStandby(mcp);

    const first = mcp.invoke(echo, { a: 1 }, toolContext);
    const second = mcp.invoke(echo, { b: 2 }, toolContext);
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    expect(connect.mock.calls[0]?.[0].demand).toBe(true);
    expect(statusOf(mcp)?.status).toBe('connecting');
    opened.resolve(live);

    await expect(first).resolves.toBeDefined();
    await expect(second).resolves.toBeDefined();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(live.invoke).toHaveBeenCalledTimes(2);
    expect(statusOf(mcp)?.status).toBe('connected');
    await mcp.close();
    expect(live.close).toHaveBeenCalledTimes(1);
  });

  it('dispatches against the live schema and refuses a tool the server dropped', async () => {
    const live = liveConnection([
      { ...echoTool, name: 'other', description: 'Other' },
    ]);
    const connect = vi.fn<McpConnectionFactory>(async () => live);
    const { mcp } = setup({ connect });
    await mcp.start();
    await waitForStandby(mcp);

    await expect(mcp.invoke(echo, {}, toolContext)).rejects.toThrow(
      'MCP tool is no longer available: machine.echo',
    );
    expect(live.invoke).not.toHaveBeenCalled();
    await mcp.close();
  });

  it('keeps descriptors and does not retry after a failed activation', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const connect = vi.fn<McpConnectionFactory>(async () => {
        throw new Error('cell_capacity_exhausted');
      });
      const { mcp } = setup({ connect });
      await mcp.start();
      await waitForStandby(mcp);

      await expect(mcp.invoke(echo, {}, toolContext)).rejects.toThrow(
        'cell_capacity_exhausted',
      );
      expect(statusOf(mcp)?.status).toBe('standby');
      expect(statusOf(mcp)?.lastError?.message).toBe('cell_capacity_exhausted');
      expect(await toolNames(mcp)).toEqual(['machine.echo']);

      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(connect).toHaveBeenCalledTimes(1);
      await mcp.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops waiting for a cancelled caller without cancelling the shared activation', async () => {
    const live = liveConnection();
    const opened = deferred<McpConnection>();
    const connect = vi.fn<McpConnectionFactory>(() => opened.promise);
    const { mcp } = setup({ connect });
    await mcp.start();
    await waitForStandby(mcp);

    const cancelled = new AbortController();
    const abandoned = mcp.invoke(
      echo,
      {},
      {
        ...toolContext,
        signal: cancelled.signal,
      },
    );
    const kept = mcp.invoke(echo, {}, toolContext);
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    cancelled.abort(new Error('caller cancelled'));
    await expect(abandoned).rejects.toThrow();

    opened.resolve(live);
    await expect(kept).resolves.toBeDefined();
    expect(live.invoke).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
    await mcp.close();
  });

  it('returns to standby when the server closes the connection, without reconnecting', async () => {
    let options: ConnectMcpServerOptions | undefined;
    const live = liveConnection();
    const connect = vi.fn<McpConnectionFactory>(async (value) => {
      options = value;
      return live;
    });
    const { mcp, catalogFetch } = setup({ connect });
    await mcp.start();
    await waitForStandby(mcp);
    await mcp.invoke(echo, {}, toolContext);
    expect(statusOf(mcp)?.status).toBe('connected');

    options?.onDisconnect?.(live);

    await waitForStandby(mcp);
    await vi.waitFor(() => expect(catalogFetch).toHaveBeenCalledTimes(2));
    expect(connect).toHaveBeenCalledTimes(1);
    expect(await toolNames(mcp)).toEqual(['machine.echo']);
    await mcp.close();
  });

  it('drops descriptors when activation requires authorization', async () => {
    const connect = vi.fn<McpConnectionFactory>(async () => {
      throw new McpAuthorizationRequiredError('machine');
    });
    const { mcp } = setup({ connect });
    await mcp.start();
    await waitForStandby(mcp);

    await expect(mcp.invoke(echo, {}, toolContext)).rejects.toBeInstanceOf(
      McpAuthorizationRequiredError,
    );
    expect(statusOf(mcp)?.status).toBe('authorization_required');
    expect(await toolNames(mcp)).toEqual([]);
    await mcp.close();
  });

  it('lists nothing when the catalog revokes access', async () => {
    const connect = vi.fn<McpConnectionFactory>();
    const { mcp } = setup({
      connect,
      catalog: () => new Response(null, { status: 403 }),
    });
    await mcp.start();

    await vi.waitFor(() => expect(statusOf(mcp)?.status).toBe('error'));
    expect(await toolNames(mcp)).toEqual([]);
    expect(connect).not.toHaveBeenCalled();
    await mcp.close();
  });

  it('connects passively when the catalog has no descriptors for this generation', async () => {
    const live = liveConnection();
    const connect = vi.fn<McpConnectionFactory>(async () => live);
    const { mcp } = setup({
      connect,
      catalog: () =>
        jsonResponse({
          version: 1,
          generation: 3,
          catalogStatus: 'missing',
          catalog: null,
        }),
    });
    await mcp.start();

    await vi.waitFor(() => expect(statusOf(mcp)?.status).toBe('connected'));
    expect(connect.mock.calls[0]?.[0].demand).toBeUndefined();
    await mcp.close();
  });

  it('closes the live connection and forgets descriptors on removal', async () => {
    const live = liveConnection();
    const connect = vi.fn<McpConnectionFactory>(async () => live);
    const { mcp, publish } = setup({ connect });
    await mcp.start();
    await waitForStandby(mcp);
    await mcp.invoke(echo, {}, toolContext);

    await publish({});

    expect(await toolNames(mcp)).toEqual([]);
    await vi.waitFor(() => expect(live.close).toHaveBeenCalledTimes(1));
    expect(statusOf(mcp)).toBeUndefined();
    await mcp.close();
  });

  it('keeps always-on servers connecting eagerly', async () => {
    const live = liveConnection();
    const connect = vi.fn<McpConnectionFactory>(async () => live);
    const { mcp, catalogFetch } = setup({
      connect,
      servers: { always: { url: 'https://always.example/mcp' } },
    });
    await mcp.start();

    await vi.waitFor(() =>
      expect(statusOf(mcp, 'always')?.status).toBe('connected'),
    );
    expect(catalogFetch).not.toHaveBeenCalled();
    expect(connect.mock.calls[0]?.[0].demand).toBeUndefined();
    await mcp.close();
  });
});
