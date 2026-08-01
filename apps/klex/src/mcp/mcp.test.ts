import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RootLogger } from '@stagewise/logger';
import type {
  PushNotification,
  PushNotificationNotification,
} from '@stagewise/mcp-extension-push-notifications';

import type {
  Config,
  ConfigListener,
  KlexConfig,
  McpServerConfig,
} from '@/config';

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

const pushNotification: PushNotification = {
  eventId: 'event-1',
  sourceId: 'chat:local',
  type: 'chat.message.received',
  createdAt: '2026-07-20T10:30:00.000Z',
  content: [{ type: 'text', text: 'hello' }],
};

const toolContext = {
  executionId: 'test',
  signal: new AbortController().signal,
};

afterEach(() => {
  vi.useRealTimers();
});

function createConfigHarness(initial: Record<string, McpServerConfig>): {
  config: Config;
  publish(servers: Record<string, McpServerConfig>): Promise<void>;
} {
  let servers = structuredClone(initial);
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
  return {
    config,
    async publish(next) {
      servers = structuredClone(next);
      await listener?.({ mcpServers: servers } as unknown as KlexConfig);
    },
  };
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
    supportsPushNotifications: false,
    pushNotifications: {},
    invoke: vi.fn(),
    close: vi.fn(async () => undefined),
  } as unknown as McpConnection;
}

function pushNotificationConnection(
  pushNotifications: Record<string, unknown>,
): McpConnection {
  return {
    ...connection('chat'),
    supportsPushNotifications: true,
    pushNotifications,
  } as unknown as McpConnection;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function setup(
  servers: Record<string, McpServerConfig>,
  connect: McpConnectionFactory,
) {
  const config = createConfigHarness(servers);
  return {
    config,
    mcp: createMcp({
      logging,
      config: config.config,
      connect,
    }),
  };
}

async function namespaceNames(
  mcp: ReturnType<typeof createMcp>,
): Promise<string[]> {
  const snapshot = await mcp.snapshot(toolContext);
  return snapshot.namespaces.map(({ name }) => name);
}

async function waitForNamespace(
  mcp: ReturnType<typeof createMcp>,
  namespace: string,
): Promise<void> {
  await vi.waitFor(async () => {
    expect(await namespaceNames(mcp)).toContain(namespace);
  });
}

describe('MCP Push Notification subscriptions', () => {
  it('registers listeners and returns an idempotent unsubscribe function', async () => {
    const { mcp } = setup({}, async () => connection('unused'));
    const listener = vi.fn();

    const unsubscribe = mcp.onPushNotification(listener);
    unsubscribe();
    unsubscribe();

    await mcp.start();
    await mcp.close();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('MCP Push Notification worker', () => {
  it('subscribes before draining and acknowledges after publication', async () => {
    const order: string[] = [];
    const closed = deferred<void>();
    const server = pushNotificationConnection({
      listen: vi.fn(async () => {
        order.push('listen');
        return { closed: closed.promise };
      }),
      getEvents: vi.fn(async () => {
        order.push('get');
        return { events: [pushNotification], hasMore: false };
      }),
      acknowledgeEvents: vi.fn(async () => {
        order.push('ack');
      }),
    });
    const { mcp } = setup(
      { chat: { url: 'https://chat.example/mcp' } },
      async () => server,
    );
    mcp.onPushNotification(() => {
      order.push('publish');
    });

    await mcp.start();
    await vi.waitFor(() => expect(order).toContain('ack'));
    expect(order).toEqual(['listen', 'get', 'publish', 'ack']);
    await mcp.close();
  });

  it('retries acknowledgement without republishing the event', async () => {
    vi.useFakeTimers();
    const closed = deferred<void>();
    const acknowledgeEvents = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValue(undefined);
    const server = pushNotificationConnection({
      listen: vi.fn(async () => ({ closed: closed.promise })),
      getEvents: vi.fn(async () => ({
        events: [pushNotification],
        hasMore: false,
      })),
      acknowledgeEvents,
    });
    const { mcp } = setup(
      { chat: { url: 'https://chat.example/mcp' } },
      async () => server,
    );
    const listener = vi.fn();
    mcp.onPushNotification(listener);

    await mcp.start();
    await vi.waitFor(() => expect(acknowledgeEvents).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(acknowledgeEvents).toHaveBeenCalledTimes(2));
    expect(listener).toHaveBeenCalledOnce();
    await mcp.close();
  });

  it('deduplicates a live event received during pending recovery', async () => {
    const pendingPage = deferred<{
      events: PushNotification[];
      hasMore: boolean;
    }>();
    const closed = deferred<void>();
    let connectOptions: ConnectMcpServerOptions | undefined;
    const acknowledgeEvents = vi.fn(async () => undefined);
    const server = pushNotificationConnection({
      listen: vi.fn(async () => ({ closed: closed.promise })),
      getEvents: vi.fn(async () => pendingPage.promise),
      acknowledgeEvents,
    });
    const { mcp } = setup(
      { chat: { url: 'https://chat.example/mcp' } },
      async (options) => {
        connectOptions = options;
        return server;
      },
    );
    const listener = vi.fn();
    mcp.onPushNotification(listener);

    await mcp.start();
    await vi.waitFor(() => expect(connectOptions).toBeDefined());
    await connectOptions?.onPushNotification(server, {
      method: 'io.stagewise/push-notifications/event',
      params: { event: pushNotification },
    } as PushNotificationNotification);
    pendingPage.resolve({ events: [pushNotification], hasMore: false });

    await vi.waitFor(() => expect(acknowledgeEvents).toHaveBeenCalledTimes(2));
    expect(listener).toHaveBeenCalledTimes(1);
    await mcp.close();
  });
});

describe('MCP namespace isolation', () => {
  it('starts immediately and publishes a healthy namespace independently', async () => {
    const pending = deferred<McpConnection>();
    const { mcp } = setup(
      {
        hanging: { url: 'https://hanging.example/mcp' },
        healthy: { url: 'https://healthy.example/mcp' },
      },
      async ({ namespace }) =>
        namespace === 'hanging' ? pending.promise : connection(namespace),
    );

    await mcp.start();
    await waitForNamespace(mcp, 'healthy');
    expect(await namespaceNames(mcp)).toEqual(['healthy']);
    expect(mcp.getServerStatuses()).toEqual([
      expect.objectContaining({ name: 'hanging', status: 'connecting' }),
      expect.objectContaining({ name: 'healthy', status: 'connected' }),
    ]);
    await mcp.close();
  });

  it('retries a failed namespace while another namespace remains pending', async () => {
    vi.useFakeTimers();
    const pending = deferred<McpConnection>();
    const attempts = new Map<string, number>();
    const connect = vi.fn(async ({ namespace }: ConnectMcpServerOptions) => {
      attempts.set(namespace, (attempts.get(namespace) ?? 0) + 1);
      if (namespace === 'hanging') return pending.promise;
      throw new Error('offline');
    });
    const { mcp } = setup(
      {
        failing: { url: 'https://failing.example/mcp' },
        hanging: { url: 'https://hanging.example/mcp' },
      },
      connect,
    );

    await mcp.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts.get('failing')).toBe(1);
    expect(mcp.getServerStatuses()).toContainEqual(
      expect.objectContaining({ name: 'failing', status: 'error' }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(attempts.get('failing')).toBe(2);
    expect(attempts.get('hanging')).toBe(1);
    await mcp.close();
  });

  it('connects an added namespace while an earlier attempt remains pending', async () => {
    const pending = deferred<McpConnection>();
    const connect = vi.fn(async ({ namespace }: ConnectMcpServerOptions) =>
      namespace === 'hanging' ? pending.promise : connection(namespace),
    );
    const { config, mcp } = setup(
      { hanging: { url: 'https://hanging.example/mcp' } },
      connect,
    );

    await mcp.start();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    await config.publish({
      added: { url: 'https://added.example/mcp' },
      hanging: { url: 'https://hanging.example/mcp' },
    });
    await waitForNamespace(mcp, 'added');
    expect(connect).toHaveBeenCalledTimes(2);
    await mcp.close();
  });

  it('replaces a pending namespace and closes the old connection', async () => {
    const oldPending = deferred<McpConnection>();
    const oldConnection = connection('server');
    const replacement = connection('server');
    const connect = vi.fn(async ({ config }: ConnectMcpServerOptions) =>
      'url' in config && config.url === 'https://old.example/mcp'
        ? oldPending.promise
        : replacement,
    );
    const { config, mcp } = setup(
      { server: { url: 'https://old.example/mcp' } },
      connect,
    );

    await mcp.start();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    await config.publish({ server: { url: 'https://new.example/mcp' } });
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    await waitForNamespace(mcp, 'server');

    oldPending.resolve(oldConnection);
    await vi.waitFor(() => expect(oldConnection.close).toHaveBeenCalledOnce());
    expect(replacement.close).not.toHaveBeenCalled();
    await mcp.close();
  });

  it('removes a pending namespace and closes its late result', async () => {
    const pending = deferred<McpConnection>();
    const late = connection('removed');
    const { config, mcp } = setup(
      { removed: { url: 'https://removed.example/mcp' } },
      async () => pending.promise,
    );

    await mcp.start();
    await config.publish({});
    pending.resolve(late);
    await vi.waitFor(() => expect(late.close).toHaveBeenCalledOnce());
    expect(await namespaceNames(mcp)).toEqual([]);
    expect(mcp.getServerStatuses()).toEqual([]);
    await mcp.close();
  });

  it('reconnects the same namespace after removal and re-addition', async () => {
    const oldPending = deferred<McpConnection>();
    const late = connection('server');
    const replacement = connection('server');
    const connect = vi.fn(async ({ config }: ConnectMcpServerOptions) =>
      'url' in config && config.url === 'https://old.example/mcp'
        ? oldPending.promise
        : replacement,
    );
    const { config, mcp } = setup(
      { server: { url: 'https://old.example/mcp' } },
      connect,
    );

    await mcp.start();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    await config.publish({});
    await config.publish({ server: { url: 'https://new.example/mcp' } });
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    await waitForNamespace(mcp, 'server');
    oldPending.resolve(late);
    await vi.waitFor(() => expect(late.close).toHaveBeenCalledOnce());
    await mcp.close();
  });

  it('preserves unchanged connections and retry timers across config updates', async () => {
    vi.useFakeTimers();
    const attempts = new Map<string, number>();
    const connect = vi.fn(async ({ namespace }: ConnectMcpServerOptions) => {
      attempts.set(namespace, (attempts.get(namespace) ?? 0) + 1);
      if (namespace === 'failing') throw new Error('offline');
      return connection(namespace);
    });
    const { config, mcp } = setup(
      {
        failing: { url: 'https://failing.example/mcp' },
        healthy: { url: 'https://healthy.example/mcp' },
      },
      connect,
    );

    await mcp.start();
    await vi.advanceTimersByTimeAsync(0);
    await config.publish({
      added: { url: 'https://added.example/mcp' },
      failing: { url: 'https://failing.example/mcp' },
      healthy: { url: 'https://healthy.example/mcp' },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts.get('healthy')).toBe(1);
    expect(attempts.get('added')).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(attempts.get('failing')).toBe(2);
    expect(attempts.get('healthy')).toBe(1);
    await mcp.close();
  });

  it('closes a connection that resolves after non-blocking shutdown', async () => {
    const pending = deferred<McpConnection>();
    const late = connection('late');
    const connect = vi.fn(async () => pending.promise);
    const { mcp } = setup(
      { late: { url: 'https://late.example/mcp' } },
      connect,
    );

    await mcp.start();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    await mcp.close();
    pending.resolve(late);
    await vi.waitFor(() => expect(late.close).toHaveBeenCalledOnce());
    expect(await namespaceNames(mcp)).toEqual([]);
  });
});
