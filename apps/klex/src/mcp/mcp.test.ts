import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RootLogger } from '@stagewise/logger';
import type {
  PushNotification,
  PushNotificationNotification,
} from '@stagewise/mcp-extension-push-notifications';

import type { CloudConnectivity } from '@/cloud-connectivity';
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
import { createMcp, type Mcp, shouldUseCloudAuthorization } from './mcp';
import { McpPendingAuthorizationRegistry } from './oauth/pending-authorizations';

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
    supportsRealtimeMedia: false,
    realtimeMedia: {},
    supportsResourceSubscription: false,
    invoke: vi.fn(),
    close: vi.fn(async () => undefined),
  } as unknown as McpConnection;
}

function resourceSubscriptionConnection(namespace: string): McpConnection {
  return {
    ...connection(namespace),
    supportsResourceSubscription: true,
    subscribeResource: vi.fn(async () => undefined),
    unsubscribeResource: vi.fn(async () => undefined),
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
  realtimeMediaEnabled = true,
  cloudConnectivity?: Partial<CloudConnectivity>,
) {
  const realtimeMediaCapability = realtimeMediaEnabled
    ? { transports: ['livekit-room'], media: ['audio'] as ['audio'] }
    : undefined;
  const config = createConfigHarness(servers);
  return {
    config,
    mcp: createMcp({
      logging,
      config: config.config,
      realtimeMediaCapability,
      dataDirectory: join(tmpdir(), 'klex-mcp-test'),
      connect,
      ...(cloudConnectivity
        ? { cloudConnectivity: cloudConnectivity as CloudConnectivity }
        : {}),
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

describe('MCP Realtime Media configuration', () => {
  it('disables capability registration and lifecycle operations', async () => {
    const options = deferred<ConnectMcpServerOptions>();
    const { mcp } = setup(
      { chat: { url: 'https://example.com/mcp' } },
      async (value) => {
        options.resolve(value);
        return connection('chat');
      },
      false,
    );

    await mcp.start();
    expect((await options.promise).realtimeMediaCapability).toBeUndefined();
    await expect(
      mcp.acceptRealtimeMediaSession('chat', 'call-1'),
    ).rejects.toThrow('Realtime Media is disabled in Klex configuration');
    await mcp.close();
  });
});

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

  it('reports the last connection failure and the next retry time', async () => {
    vi.useFakeTimers();
    const { mcp } = setup(
      { failing: { url: 'https://failing.example/mcp' } },
      async () => {
        throw new Error('offline');
      },
    );

    await mcp.start();
    await vi.advanceTimersByTimeAsync(0);
    const failing = mcp
      .getServerStatuses()
      .find((server) => server.name === 'failing');
    expect(failing?.status).toBe('error');
    expect(failing?.lastError).toMatchObject({
      name: 'Error',
      message: 'offline',
    });
    expect(failing?.lastError?.at).toEqual(expect.any(String));
    expect(failing?.nextRetryAt).toEqual(expect.any(String));
    await mcp.close();
  });

  it('clears the last connection failure once a namespace connects', async () => {
    vi.useFakeTimers();
    let firstAttempt = true;
    const { mcp } = setup(
      { flaky: { url: 'https://flaky.example/mcp' } },
      async ({ namespace }: ConnectMcpServerOptions) => {
        if (firstAttempt) {
          firstAttempt = false;
          throw new Error('offline');
        }
        return connection(namespace);
      },
    );

    await mcp.start();
    await vi.advanceTimersByTimeAsync(0);
    // The first retry fires after RETRY_INITIAL_MS and succeeds.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await namespaceNames(mcp)).toContain('flaky');
    const flaky = mcp
      .getServerStatuses()
      .find((server) => server.name === 'flaky');
    expect(flaky?.status).toBe('connected');
    expect(flaky?.lastError).toBeNull();
    expect(flaky?.nextRetryAt).toBeNull();
    await mcp.close();
  });

  it('does not retry a namespace that requires authorization', async () => {
    vi.useFakeTimers();
    const connect = vi.fn(async () => {
      throw new McpAuthorizationRequiredError(new Error('unauthorized'));
    });
    const { mcp } = setup(
      { protected: { url: 'https://protected.example/mcp' } },
      connect,
    );

    await mcp.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(connect).toHaveBeenCalledOnce();
    expect(mcp.getServerStatuses()).toContainEqual(
      expect.objectContaining({
        name: 'protected',
        status: 'authorization_required',
      }),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(connect).toHaveBeenCalledOnce();
    await mcp.close();
  });

  it('clears stale diagnostics when a retry requires authorization', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const { mcp } = setup(
      { protected: { url: 'https://protected.example/mcp' } },
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('offline');
        throw new McpAuthorizationRequiredError(new Error('unauthorized'));
      },
    );

    await mcp.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(serverRow(mcp, 'protected')).toMatchObject({
      status: 'error',
      lastError: { message: 'offline' },
      nextRetryAt: expect.any(String),
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(serverRow(mcp, 'protected')).toMatchObject({
      status: 'authorization_required',
      lastError: null,
      nextRetryAt: null,
    });
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

  it('changes the connection identity on reconnect and omits it while disconnected', async () => {
    const { config, mcp } = setup(
      { server: { url: 'https://example.com/mcp' } },
      async ({ namespace }) => connection(namespace),
    );
    await mcp.start();
    await waitForNamespace(mcp, 'server');
    const first = mcp.getServerStatuses()[0]?.connectionId;
    expect(first).toEqual(expect.any(String));
    expect(mcp.getServerStatuses()[0]?.connectionId).toBe(first);
    await config.publish({});
    expect(mcp.getServerStatuses()).toEqual([]);
    await config.publish({ server: { url: 'https://example.com/mcp' } });
    await waitForNamespace(mcp, 'server');
    expect(mcp.getServerStatuses()[0]?.connectionId).toEqual(
      expect.any(String),
    );
    expect(mcp.getServerStatuses()[0]?.connectionId).not.toBe(first);
    await mcp.close();
    expect(mcp.getServerStatuses()[0]?.connectionId).toBeUndefined();
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

  it('exposes realtime lifecycle operations and notifications by namespace', async () => {
    let options: ConnectMcpServerOptions | undefined;
    const accept = vi.fn(async () => ({
      transport: {
        profile: 'livekit-room' as const,
        url: 'wss://livekit.example.com',
        token: 'secret',
      },
    }));
    const reject = vi.fn(async () => undefined);
    const end = vi.fn(async () => undefined);
    const realtimeConnection = {
      ...connection('voice'),
      supportsRealtimeMedia: true,
      realtimeMedia: {
        listen: vi.fn(async () => ({ closed: new Promise(() => undefined) })),
        accept,
        reject,
        end,
      },
    } as unknown as McpConnection;
    const connect = vi.fn(async (input: ConnectMcpServerOptions) => {
      options = input;
      return realtimeConnection;
    });
    const { mcp } = setup(
      { voice: { url: 'https://voice.example/mcp' } },
      connect,
    );
    const listener = vi.fn();
    mcp.onRealtimeMediaNotification(listener);

    await mcp.start();
    await waitForNamespace(mcp, 'voice');
    await options?.onRealtimeMediaNotification(realtimeConnection, {
      jsonrpc: '2.0',
      method: 'io.stagewise/realtime-media/session-offered',
      params: {
        sessionId: 'session-1',
        expiresAt: '2026-08-01T18:00:00.000Z',
      },
    });
    await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());
    await expect(
      mcp.acceptRealtimeMediaSession('voice', 'session-1'),
    ).resolves.toMatchObject({ transport: { profile: 'livekit-room' } });
    await mcp.rejectRealtimeMediaSession('voice', 'session-2');
    await mcp.endRealtimeMediaSession('voice', 'session-1');
    expect(accept).toHaveBeenCalledWith('session-1');
    expect(reject).toHaveBeenCalledWith('session-2');
    expect(end).toHaveBeenCalledWith('session-1');
    await mcp.close();
  });

  it('publishes realtime availability transitions without duplicates', async () => {
    let options: ConnectMcpServerOptions | undefined;
    const connectionWithRealtime = {
      ...connection('voice'),
      supportsRealtimeMedia: true,
      realtimeMedia: {
        listen: vi.fn(async () => ({ closed: new Promise(() => undefined) })),
      },
    } as unknown as McpConnection;
    const { mcp } = setup(
      { voice: { url: 'https://voice.example/mcp' } },
      async (input) => {
        options = input;
        return connectionWithRealtime;
      },
    );
    const listener = vi.fn();
    mcp.onRealtimeMediaAvailability(listener);

    await mcp.start();
    await vi.waitFor(() =>
      expect(listener).toHaveBeenCalledWith({
        namespace: 'voice',
        available: true,
      }),
    );
    options?.onDisconnect(connectionWithRealtime);
    options?.onDisconnect(connectionWithRealtime);
    await vi.waitFor(() =>
      expect(listener).toHaveBeenLastCalledWith({
        namespace: 'voice',
        available: false,
      }),
    );
    expect(listener.mock.calls).toEqual([
      [{ namespace: 'voice', available: true }],
      [{ namespace: 'voice', available: false }],
    ]);
    await mcp.close();
  });

  it('publishes unavailability when the realtime subscription fails', async () => {
    const subscriptionClosed = deferred<void>();
    const connectionWithRealtime = {
      ...connection('voice'),
      supportsRealtimeMedia: true,
      realtimeMedia: {
        listen: vi.fn(async () => ({ closed: subscriptionClosed.promise })),
      },
    } as unknown as McpConnection;
    const { mcp } = setup(
      { voice: { url: 'https://voice.example/mcp' } },
      async () => connectionWithRealtime,
    );
    const listener = vi.fn();
    mcp.onRealtimeMediaAvailability(listener);

    await mcp.start();
    await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());
    subscriptionClosed.resolve();
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(2));
    expect(listener).toHaveBeenLastCalledWith({
      namespace: 'voice',
      available: false,
    });
    expect(connectionWithRealtime.close).toHaveBeenCalledOnce();
    expect(serverRow(mcp, 'voice')).toMatchObject({
      status: 'error',
      lastError: {
        name: 'Error',
        message: 'Realtime Media subscription closed',
        at: expect.any(String),
      },
      nextRetryAt: expect.any(String),
    });
    await mcp.close();
  });

  it('ignores stale realtime disconnect callbacks after replacement', async () => {
    const connections: McpConnection[] = [];
    const options: ConnectMcpServerOptions[] = [];
    const { config, mcp } = setup(
      { voice: { url: 'https://one.example/mcp' } },
      async (input) => {
        options.push(input);
        const created = {
          ...connection('voice'),
          supportsRealtimeMedia: true,
          realtimeMedia: {
            listen: vi.fn(async () => ({
              closed: new Promise(() => undefined),
            })),
          },
        } as unknown as McpConnection;
        connections.push(created);
        return created;
      },
    );
    const listener = vi.fn();
    mcp.onRealtimeMediaAvailability(listener);

    await mcp.start();
    await vi.waitFor(() => expect(connections).toHaveLength(1));
    await config.publish({ voice: { url: 'https://two.example/mcp' } });
    await vi.waitFor(() => expect(connections).toHaveLength(2));
    const callCount = listener.mock.calls.length;
    options[0]?.onDisconnect(connections[0] as McpConnection);
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(callCount);
    await mcp.close();
    expect(listener).toHaveBeenLastCalledWith({
      namespace: 'voice',
      available: false,
    });
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

describe('MCP cloud auth (discovery-driven)', () => {
  it('connects HTTP servers without cloudAuth when cloud connectivity is absent', async () => {
    const captured = deferred<ConnectMcpServerOptions>();
    const connect = vi.fn(async (opts: ConnectMcpServerOptions) => {
      captured.resolve(opts);
      return connection('cloud-mcp');
    });
    const { mcp } = setup(
      { 'cloud-mcp': { url: 'https://cloud.example/mcp' } },
      connect,
      false,
    );

    await mcp.start();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    expect((await captured.promise).cloudAuth).toBeUndefined();
    await mcp.close();
  });

  it('passes cloudAuth to every HTTP server when cloud is enabled', async () => {
    const captured = deferred<ConnectMcpServerOptions>();
    const connect = vi.fn(async (opts: ConnectMcpServerOptions) => {
      captured.resolve(opts);
      return connection('cloud-mcp');
    });
    const getAccessToken = vi.fn(async () => 'cloud-bearer-token');
    const invalidateAccessToken = vi.fn();
    const { mcp } = setup(
      { 'cloud-mcp': { url: 'https://cloud.example/mcp' } },
      connect,
      false,
      { isCloudEnabled: () => true, getAccessToken, invalidateAccessToken },
    );

    await mcp.start();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());

    const opts = await captured.promise;
    expect(opts.cloudAuth).toBeDefined();
    const token = await opts.cloudAuth?.getAccessToken(
      'https://cloud.example/mcp',
      ['mcp:access'],
    );
    expect(token).toBe('cloud-bearer-token');
    expect(getAccessToken).toHaveBeenCalledWith('https://cloud.example/mcp', [
      'mcp:access',
    ]);

    // Verify invalidate is wired through
    opts.cloudAuth?.invalidate('https://cloud.example/mcp');
    expect(invalidateAccessToken).toHaveBeenCalledWith(
      'https://cloud.example/mcp',
    );

    await mcp.close();
  });

  it('connects HTTP servers regardless of cloud state', async () => {
    const connect = vi.fn(async () => connection('local-mcp'));
    const { mcp } = setup(
      { 'local-mcp': { url: 'https://local.example/mcp' } },
      connect,
      false,
      { isCloudEnabled: () => false, getAccessToken: vi.fn() },
    );

    await mcp.start();
    await waitForNamespace(mcp, 'local-mcp');
    await mcp.close();
  });
});

const cloudReady: Partial<CloudConnectivity> = {
  isCloudEnabled: () => true,
  isEnrolled: () => true,
  getTunnelState: () => 'connected',
  getCloudBaseUrl: () => 'https://cloud.example.com',
};

describe('MCP OAuth channel selection', () => {
  it('keeps enrolled agents on cloud OAuth while the tunnel is disconnected', () => {
    expect(
      shouldUseCloudAuthorization({
        ...cloudReady,
        getTunnelState: () => 'disconnected',
      } as CloudConnectivity),
    ).toBe(true);
  });

  it('uses local OAuth for agents that are not cloud-managed', () => {
    expect(
      shouldUseCloudAuthorization({
        ...cloudReady,
        isEnrolled: () => false,
      } as CloudConnectivity),
    ).toBe(false);
    expect(shouldUseCloudAuthorization(undefined)).toBe(false);
  });
});

function setupAuthorization(
  servers: Record<string, McpServerConfig>,
  connect: McpConnectionFactory,
  cloudConnectivity: Partial<CloudConnectivity> = cloudReady,
) {
  const config = createConfigHarness(servers);
  const pendingAuthorizations = new McpPendingAuthorizationRegistry();
  return {
    config,
    pendingAuthorizations,
    mcp: createMcp({
      logging,
      config: config.config,
      dataDirectory: join(tmpdir(), 'klex-mcp-test'),
      connect,
      cloudConnectivity: cloudConnectivity as CloudConnectivity,
      pendingAuthorizations,
    }),
  };
}

function serverRow(mcp: Mcp, name: string) {
  return mcp.getServerStatuses().find((server) => server.name === name);
}

function authorizationOf(mcp: Mcp, name: string) {
  return serverRow(mcp, name)?.authorization ?? null;
}

describe('MCP cloud authorization requests', () => {
  it('reuses initial OAuth discovery when Connect is clicked before consent is ready', async () => {
    const discovery = deferred<void>();
    const connect = vi.fn(
      async ({ namespace, signal }: ConnectMcpServerOptions) => {
        await discovery.promise;
        await pendingAuthorizations.register(
          {
            serverName: namespace,
            serverUrl: 'https://protected.example/mcp',
            authorizationUrl: 'https://auth.example/authorize?state=initial',
            state: 'initial',
          },
          { signal, timeoutMs: 60_000 },
        );
        return connection(namespace);
      },
    );
    const { mcp, pendingAuthorizations } = setupAuthorization(
      { protected: { url: 'https://protected.example/mcp' } },
      connect,
    );
    await mcp.start();
    const requested = mcp.requestAuthorization('protected');
    try {
      expect(connect).toHaveBeenCalledOnce();
      expect(connect.mock.calls[0]?.[0].signal.aborted).toBe(false);
      discovery.resolve();
      expect(await requested).toMatchObject({
        outcome: 'pending',
        authorization: { state: 'initial' },
      });
      expect(
        mcp.completeAuthorization(
          'initial',
          new URLSearchParams({ code: 'approved' }),
        ),
      ).toBe('accepted');
      await waitForNamespace(mcp, 'protected');
      expect(connect).toHaveBeenCalledOnce();
    } finally {
      discovery.resolve();
      await requested;
      await mcp.close();
    }
  });

  it('reports unknown servers and servers that do not use interactive OAuth', async () => {
    const { mcp } = setupAuthorization(
      {
        local: { command: 'node', args: ['server.js'] },
        keyed: {
          url: 'https://keyed.example/mcp',
          headers: { Authorization: 'Bearer static' },
        },
      },
      async ({ namespace }: ConnectMcpServerOptions) => connection(namespace),
    );

    await mcp.start();
    expect(await mcp.requestAuthorization('missing')).toEqual({
      outcome: 'not_found',
    });
    expect(await mcp.requestAuthorization('local')).toEqual({
      outcome: 'unsupported_transport',
    });
    expect(await mcp.requestAuthorization('keyed')).toEqual({
      outcome: 'manual_credentials',
    });
    expect(serverRow(mcp, 'local')?.usesInteractiveOAuth).toBe(false);
    expect(serverRow(mcp, 'keyed')?.usesInteractiveOAuth).toBe(false);
    await mcp.close();
  });

  it('reports the cloud channel as unavailable while the tunnel is down', async () => {
    const { mcp } = setupAuthorization(
      { protected: { url: 'https://protected.example/mcp' } },
      async () => {
        throw new McpAuthorizationRequiredError(new Error('unauthorized'));
      },
      { ...cloudReady, getTunnelState: () => 'disconnected' },
    );

    await mcp.start();
    expect(await mcp.requestAuthorization('protected')).toEqual({
      outcome: 'unavailable',
    });
    await mcp.close();
  });

  it('returns a parked authorization after the tunnel disconnects', async () => {
    const { mcp, pendingAuthorizations } = setupAuthorization(
      { protected: { url: 'https://protected.example/mcp' } },
      async ({ namespace, signal }: ConnectMcpServerOptions) => {
        await pendingAuthorizations.register(
          {
            serverName: namespace,
            serverUrl: 'https://protected.example/mcp',
            authorizationUrl: 'https://auth.example/authorize?state=secret',
            state: 'secret',
          },
          { signal, timeoutMs: 60_000 },
        );
        return connection(namespace);
      },
      { ...cloudReady, getTunnelState: () => 'disconnected' },
    );

    await mcp.start();
    await vi.waitFor(() =>
      expect(authorizationOf(mcp, 'protected')).not.toBeNull(),
    );
    expect(await mcp.requestAuthorization('protected')).toMatchObject({
      outcome: 'pending',
      authorization: { serverName: 'protected', state: 'secret' },
    });
    await mcp.close();
  });

  it('re-drives a connection attempt and returns the parked authorization', async () => {
    let parked = false;
    const { mcp, pendingAuthorizations } = setupAuthorization(
      { protected: { url: 'https://protected.example/mcp' } },
      async ({ namespace, signal }: ConnectMcpServerOptions) => {
        // First attempt fails outright; later attempts park an authorization the
        // way the cloud session factory does.
        if (!parked) {
          parked = true;
          throw new McpAuthorizationRequiredError(new Error('unauthorized'));
        }
        await pendingAuthorizations.register(
          {
            serverName: namespace,
            serverUrl: 'https://protected.example/mcp',
            authorizationUrl: 'https://auth.example/authorize?state=secret',
            state: 'secret',
          },
          { signal, timeoutMs: 60_000 },
        );
        return connection(namespace);
      },
    );

    await mcp.start();
    await vi.waitFor(() =>
      expect(mcp.getServerStatuses()).toContainEqual(
        expect.objectContaining({
          name: 'protected',
          status: 'authorization_required',
        }),
      ),
    );

    const result = await mcp.requestAuthorization('protected');
    expect(result).toMatchObject({
      outcome: 'pending',
      authorization: { serverName: 'protected', state: 'secret' },
    });
    if (result.outcome !== 'pending') throw new Error('Expected authorization');
    expect(authorizationOf(mcp, 'protected')).toMatchObject({
      id: expect.any(String),
    });

    // A second request is idempotent while the first is still live.
    const repeated = await mcp.requestAuthorization('protected');
    expect(repeated).toEqual(result);
    expect(authorizationOf(mcp, 'protected')).toEqual({
      id: result.authorization.id,
      createdAt: result.authorization.createdAt,
      expiresAt: result.authorization.expiresAt,
    });

    expect(
      mcp.completeAuthorization(
        'secret',
        new URLSearchParams({ code: 'auth-code' }),
      ),
    ).toBe('accepted');
    await waitForNamespace(mcp, 'protected');
    await mcp.close();
  });

  it('times out when the attempt never reaches the authorization step', async () => {
    vi.useFakeTimers();
    const { mcp } = setupAuthorization(
      { protected: { url: 'https://protected.example/mcp' } },
      async () => {
        throw new McpAuthorizationRequiredError(new Error('unauthorized'));
      },
    );

    await mcp.start();
    await vi.advanceTimersByTimeAsync(0);
    const result = mcp.requestAuthorization('protected');
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await result).toEqual({ outcome: 'timeout' });
    await mcp.close();
  });

  it('cancels a pending authorization', async () => {
    const { mcp, pendingAuthorizations } = setupAuthorization(
      { protected: { url: 'https://protected.example/mcp' } },
      async ({ namespace, signal }: ConnectMcpServerOptions) => {
        await pendingAuthorizations.register(
          {
            serverName: namespace,
            serverUrl: 'https://protected.example/mcp',
            authorizationUrl: 'https://auth.example/authorize?state=secret',
            state: 'secret',
          },
          { signal, timeoutMs: 60_000 },
        );
        return connection(namespace);
      },
    );

    await mcp.start();
    await vi.waitFor(() =>
      expect(authorizationOf(mcp, 'protected')).not.toBeNull(),
    );
    expect(mcp.cancelAuthorization('protected')).toBe(true);
    expect(mcp.cancelAuthorization('unknown')).toBe(false);
    expect(authorizationOf(mcp, 'protected')).toBeNull();
    await mcp.close();
  });
});

describe('MCP Resource Subscriptions', () => {
  it('subscribeResource delegates to the connection', async () => {
    const conn = resourceSubscriptionConnection('server');
    const { mcp } = setup(
      { server: { url: 'https://example.com/mcp' } },
      async () => conn,
    );
    await mcp.start();
    await waitForNamespace(mcp, 'server');

    await mcp.subscribeResource(
      'server',
      'file:///data.txt',
      AbortSignal.timeout(5_000),
    );
    expect(conn.subscribeResource).toHaveBeenCalledWith(
      'file:///data.txt',
      expect.any(AbortSignal),
    );
    await mcp.close();
  });

  it('unsubscribeResource delegates to the connection', async () => {
    const conn = resourceSubscriptionConnection('server');
    const { mcp } = setup(
      { server: { url: 'https://example.com/mcp' } },
      async () => conn,
    );
    await mcp.start();
    await waitForNamespace(mcp, 'server');

    await mcp.subscribeResource(
      'server',
      'file:///data.txt',
      AbortSignal.timeout(5_000),
    );
    await mcp.unsubscribeResource(
      'server',
      'file:///data.txt',
      AbortSignal.timeout(5_000),
    );
    expect(conn.unsubscribeResource).toHaveBeenCalledWith(
      'file:///data.txt',
      expect.any(AbortSignal),
    );
    await mcp.close();
  });

  it('supportsResourceSubscription reflects server capabilities', async () => {
    const conn = resourceSubscriptionConnection('server');
    const { mcp } = setup(
      { server: { url: 'https://example.com/mcp' } },
      async () => conn,
    );
    await mcp.start();
    await waitForNamespace(mcp, 'server');

    expect(mcp.supportsResourceSubscription('server')).toBe(true);
    await mcp.close();
  });

  it('supportsResourceSubscription returns false for unsupported server', async () => {
    const { mcp } = setup(
      { server: { url: 'https://example.com/mcp' } },
      async () => connection('server'),
    );
    await mcp.start();
    await waitForNamespace(mcp, 'server');

    expect(mcp.supportsResourceSubscription('server')).toBe(false);
    await mcp.close();
  });

  it('onResourceUpdated listener receives updates', async () => {
    const conn = resourceSubscriptionConnection('server');
    let connectOptions: ConnectMcpServerOptions | undefined;
    const { mcp } = setup(
      { server: { url: 'https://example.com/mcp' } },
      async (opts) => {
        connectOptions = opts;
        return conn;
      },
    );
    await mcp.start();
    await waitForNamespace(mcp, 'server');

    const updates: { namespace: string; uri: string }[] = [];
    const unsub = mcp.onResourceUpdated((event) => {
      updates.push(event);
    });

    // Simulate a resource updated notification
    connectOptions?.onResourceUpdated?.(conn, 'file:///data.txt');

    await vi.waitFor(() => expect(updates).toHaveLength(1));
    expect(updates.at(0)?.namespace).toBe('server');
    expect(updates.at(0)?.uri).toBe('file:///data.txt');

    unsub();
    await mcp.close();
  });

  it('ignores resource updates from a replaced connection', async () => {
    const conn1 = resourceSubscriptionConnection('server');
    const conn2 = resourceSubscriptionConnection('server');
    const connections = [conn1, conn2];
    const connectOptions: ConnectMcpServerOptions[] = [];
    const { config, mcp } = setup(
      { server: { url: 'https://example.com/mcp' } },
      async (options) => {
        connectOptions.push(options);
        return connections[connectOptions.length - 1] ?? conn2;
      },
    );
    await mcp.start();
    await waitForNamespace(mcp, 'server');
    const updates: string[] = [];
    mcp.onResourceUpdated(({ uri }) => {
      updates.push(uri);
    });

    await config.publish({
      server: { url: 'https://example.com/mcp-replaced' },
    });
    await vi.waitFor(() => expect(connectOptions).toHaveLength(2));
    await connectOptions[0]?.onResourceUpdated?.(conn1, 'file:///stale.txt');
    await connectOptions[1]?.onResourceUpdated?.(conn2, 'file:///current.txt');

    expect(updates).toEqual(['file:///current.txt']);
    await mcp.close();
  });

  it('reconnection re-subscribes tracked URIs', async () => {
    const conn1 = resourceSubscriptionConnection('server');
    const connections: McpConnection[] = [conn1];
    let connectCallCount = 0;
    const { mcp, config } = setup(
      { server: { url: 'https://example.com/mcp' } },
      async () => {
        const c = connections[connectCallCount] ?? conn1;
        connectCallCount++;
        return c;
      },
    );
    await mcp.start();
    await waitForNamespace(mcp, 'server');

    // Subscribe to a resource
    await mcp.subscribeResource(
      'server',
      'file:///tracked.txt',
      AbortSignal.timeout(5_000),
    );
    expect(conn1.subscribeResource).toHaveBeenCalledTimes(1);

    // Simulate reconnection by publishing a new config (same server)
    const conn2 = resourceSubscriptionConnection('server');
    connections.push(conn2);
    config.publish({ server: { url: 'https://example.com/mcp-v2' } });

    // Wait for reconnect and re-subscription
    await vi.waitFor(() =>
      expect(conn2.subscribeResource).toHaveBeenCalledTimes(1),
    );
    expect(conn2.subscribeResource).toHaveBeenCalledWith(
      'file:///tracked.txt',
      expect.any(AbortSignal),
    );

    await mcp.close();
  });

  it('reference-counts consumers of the same resource', async () => {
    const conn = resourceSubscriptionConnection('server');
    const { mcp } = setup(
      { server: { url: 'https://example.com/mcp' } },
      async () => conn,
    );
    await mcp.start();
    await waitForNamespace(mcp, 'server');

    await mcp.subscribeResource(
      'server',
      'file:///shared.txt',
      AbortSignal.timeout(5_000),
    );
    await mcp.subscribeResource(
      'server',
      'file:///shared.txt',
      AbortSignal.timeout(5_000),
    );
    expect(conn.subscribeResource).toHaveBeenCalledTimes(1);

    await mcp.unsubscribeResource(
      'server',
      'file:///shared.txt',
      AbortSignal.timeout(5_000),
    );
    expect(conn.unsubscribeResource).not.toHaveBeenCalled();
    await mcp.unsubscribeResource(
      'server',
      'file:///shared.txt',
      AbortSignal.timeout(5_000),
    );
    expect(conn.unsubscribeResource).toHaveBeenCalledTimes(1);
    await mcp.close();
  });

  it('shares an in-flight first subscription', async () => {
    let resolveSubscribe: (() => void) | undefined;
    const conn = resourceSubscriptionConnection('server');
    vi.mocked(conn.subscribeResource).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSubscribe = resolve;
        }),
    );
    const { mcp } = setup(
      { server: { url: 'https://example.com/mcp' } },
      async () => conn,
    );
    await mcp.start();
    await waitForNamespace(mcp, 'server');

    const first = mcp.subscribeResource(
      'server',
      'file:///shared.txt',
      AbortSignal.timeout(5_000),
    );
    const second = mcp.subscribeResource(
      'server',
      'file:///shared.txt',
      AbortSignal.timeout(5_000),
    );
    await vi.waitFor(() =>
      expect(conn.subscribeResource).toHaveBeenCalledTimes(1),
    );
    resolveSubscribe?.();
    await Promise.all([first, second]);
    await mcp.close();
  });

  it('rolls back all references when the shared subscribe fails', async () => {
    const conn = resourceSubscriptionConnection('server');
    vi.mocked(conn.subscribeResource).mockRejectedValueOnce(
      new Error('subscribe failed'),
    );
    const { mcp } = setup(
      { server: { url: 'https://example.com/mcp' } },
      async () => conn,
    );
    await mcp.start();
    await waitForNamespace(mcp, 'server');

    await expect(
      mcp.subscribeResource(
        'server',
        'file:///shared.txt',
        AbortSignal.timeout(5_000),
      ),
    ).rejects.toThrow('subscribe failed');
    await mcp.subscribeResource(
      'server',
      'file:///shared.txt',
      AbortSignal.timeout(5_000),
    );
    expect(conn.subscribeResource).toHaveBeenCalledTimes(2);
    await mcp.close();
  });

  it('keeps a concurrent acquisition live while the final release is in flight', async () => {
    const unsubscribe = deferred<void>();
    const conn = resourceSubscriptionConnection('server');
    vi.mocked(conn.unsubscribeResource).mockReturnValueOnce(
      unsubscribe.promise,
    );
    const { mcp } = setup(
      { server: { url: 'https://example.com/mcp' } },
      async () => conn,
    );
    await mcp.start();
    await waitForNamespace(mcp, 'server');

    await mcp.subscribeResource(
      'server',
      'file:///raced.txt',
      AbortSignal.timeout(5_000),
    );
    const release = mcp.unsubscribeResource(
      'server',
      'file:///raced.txt',
      AbortSignal.timeout(5_000),
    );
    await vi.waitFor(() =>
      expect(conn.unsubscribeResource).toHaveBeenCalledTimes(1),
    );

    const acquire = mcp.subscribeResource(
      'server',
      'file:///raced.txt',
      AbortSignal.timeout(5_000),
    );
    unsubscribe.resolve(undefined);
    await Promise.all([release, acquire]);
    expect(conn.subscribeResource).toHaveBeenCalledTimes(2);

    await mcp.unsubscribeResource(
      'server',
      'file:///raced.txt',
      AbortSignal.timeout(5_000),
    );
    expect(conn.unsubscribeResource).toHaveBeenCalledTimes(2);
    await mcp.close();
  });

  it('retries a failed reconnect subscription without poisoning the lease', async () => {
    const conn1 = resourceSubscriptionConnection('server');
    const conn2 = resourceSubscriptionConnection('server');
    vi.mocked(conn2.subscribeResource)
      .mockRejectedValueOnce(new Error('temporary reconnect failure'))
      .mockResolvedValue(undefined);
    const connections = [conn1, conn2];
    let connectCallCount = 0;
    const { config, mcp } = setup(
      { server: { url: 'https://example.com/mcp' } },
      async () => connections[connectCallCount++] ?? conn2,
    );
    await mcp.start();
    await waitForNamespace(mcp, 'server');
    await mcp.subscribeResource(
      'server',
      'file:///retry.txt',
      AbortSignal.timeout(5_000),
    );

    await config.publish({
      server: { url: 'https://example.com/mcp-reconnected' },
    });
    await vi.waitFor(
      () => expect(conn2.subscribeResource).toHaveBeenCalledTimes(2),
      { timeout: 3_000 },
    );

    await mcp.unsubscribeResource(
      'server',
      'file:///retry.txt',
      AbortSignal.timeout(5_000),
    );
    expect(conn2.unsubscribeResource).toHaveBeenCalledTimes(1);
    await mcp.close();
  });

  it('replaces a stale resubscription retry with one for the new connection', async () => {
    const conn1 = resourceSubscriptionConnection('server');
    const conn2 = resourceSubscriptionConnection('server');
    const conn3 = resourceSubscriptionConnection('server');
    vi.mocked(conn2.subscribeResource).mockRejectedValue(
      new Error('connection two failed'),
    );
    vi.mocked(conn3.subscribeResource)
      .mockRejectedValueOnce(new Error('connection three failed once'))
      .mockResolvedValue(undefined);
    const connections = [conn1, conn2, conn3];
    let connectCallCount = 0;
    const { config, mcp } = setup(
      { server: { url: 'https://example.com/mcp' } },
      async () => connections[connectCallCount++] ?? conn3,
    );
    await mcp.start();
    await waitForNamespace(mcp, 'server');
    await mcp.subscribeResource(
      'server',
      'file:///retry.txt',
      AbortSignal.timeout(5_000),
    );

    await config.publish({
      server: { url: 'https://example.com/mcp-v2' },
    });
    await vi.waitFor(() =>
      expect(conn2.subscribeResource).toHaveBeenCalledOnce(),
    );
    await config.publish({
      server: { url: 'https://example.com/mcp-v3' },
    });
    await vi.waitFor(
      () => expect(conn3.subscribeResource).toHaveBeenCalledTimes(2),
      { timeout: 3_000 },
    );

    await mcp.close();
  });

  it('aggregates every resource and template page when cursor is omitted', async () => {
    const conn = resourceSubscriptionConnection('server');
    conn.listResources = vi.fn().mockImplementation((_signal, cursor) => {
      if (cursor === 'resources-2') {
        return { resources: [{ name: 'two', uri: 'file:///two' }] };
      }
      return {
        resources: [{ name: 'one', uri: 'file:///one' }],
        nextCursor: 'resources-2',
      };
    });
    conn.listResourceTemplates = vi
      .fn()
      .mockImplementation((_signal, cursor) => {
        if (cursor === 'templates-2') {
          return {
            resourceTemplates: [{ name: 'two', uriTemplate: 'file:///{two}' }],
          };
        }
        return {
          resourceTemplates: [{ name: 'one', uriTemplate: 'file:///{one}' }],
          nextCursor: 'templates-2',
        };
      });
    const { mcp } = setup(
      { server: { url: 'https://example.com/mcp' } },
      async () => conn,
    );
    await mcp.start();
    await waitForNamespace(mcp, 'server');

    const result = await mcp.listResources('server');
    expect(result.resources.map((resource) => resource.name)).toEqual([
      'one',
      'two',
    ]);
    expect(result.resourceTemplates.map((template) => template.name)).toEqual([
      'one',
      'two',
    ]);
    expect(conn.listResources).toHaveBeenCalledWith(
      expect.any(AbortSignal),
      'resources-2',
    );
    expect(conn.listResourceTemplates).toHaveBeenCalledWith(
      expect.any(AbortSignal),
      'templates-2',
    );
    await mcp.close();
  });

  it('rejects an aggregated resource catalog above the total-entry limit', async () => {
    const conn = resourceSubscriptionConnection('server');
    conn.listResources = vi.fn().mockResolvedValue({
      resources: Array.from({ length: 10_001 }, (_, index) => ({
        name: `resource-${index}`,
        uri: `file:///resource-${index}`,
      })),
    });
    conn.listResourceTemplates = vi
      .fn()
      .mockResolvedValue({ resourceTemplates: [] });
    const { mcp } = setup(
      { server: { url: 'https://example.com/mcp' } },
      async () => conn,
    );
    await mcp.start();
    await waitForNamespace(mcp, 'server');

    await expect(mcp.listResources('server')).rejects.toThrow(
      'total-entry limit',
    );
    await mcp.close();
  });

  it('rejects an aggregated resource catalog above the byte limit', async () => {
    const conn = resourceSubscriptionConnection('server');
    conn.listResources = vi.fn().mockResolvedValue({
      resources: [
        {
          name: 'oversized',
          uri: 'file:///oversized',
          description: 'x'.repeat(5 * 1024 * 1024),
        },
      ],
    });
    conn.listResourceTemplates = vi
      .fn()
      .mockResolvedValue({ resourceTemplates: [] });
    const { mcp } = setup(
      { server: { url: 'https://example.com/mcp' } },
      async () => conn,
    );
    await mcp.start();
    await waitForNamespace(mcp, 'server');

    await expect(mcp.listResources('server')).rejects.toThrow(
      'serialized-size limit',
    );
    await mcp.close();
  });

  it('rejects repeated resource pagination cursors', async () => {
    const conn = resourceSubscriptionConnection('server');
    conn.listResources = vi.fn().mockResolvedValue({
      resources: [],
      nextCursor: 'same',
    });
    conn.listResourceTemplates = vi
      .fn()
      .mockResolvedValue({ resourceTemplates: [] });
    const { mcp } = setup(
      { server: { url: 'https://example.com/mcp' } },
      async () => conn,
    );
    await mcp.start();
    await waitForNamespace(mcp, 'server');

    await expect(mcp.listResources('server')).rejects.toThrow(
      'repeated cursor',
    );
    await mcp.close();
  });

  it('starts with fresh resource subscription state after close', async () => {
    const conn1 = resourceSubscriptionConnection('server');
    const conn2 = resourceSubscriptionConnection('server');
    const connections = [conn1, conn2];
    let connectCallCount = 0;
    const { mcp } = setup(
      { server: { url: 'https://example.com/mcp' } },
      async () => connections[connectCallCount++] ?? conn2,
    );
    await mcp.start();
    await waitForNamespace(mcp, 'server');
    await mcp.subscribeResource(
      'server',
      'file:///a.txt',
      AbortSignal.timeout(5_000),
    );
    await mcp.close();

    await mcp.start();
    await waitForNamespace(mcp, 'server');
    await mcp.subscribeResource(
      'server',
      'file:///a.txt',
      AbortSignal.timeout(5_000),
    );

    expect(conn2.subscribeResource).toHaveBeenCalledOnce();
    await mcp.close();
  });
});
