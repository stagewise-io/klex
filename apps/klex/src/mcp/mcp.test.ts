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
import { createMcp } from './mcp';
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

describe('MCP cloud authorization requests', () => {
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
    expect(await mcp.requestAuthorization('local')).toMatchObject({
      outcome: 'not_applicable',
    });
    expect(await mcp.requestAuthorization('keyed')).toMatchObject({
      outcome: 'not_applicable',
    });
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
    expect(mcp.listPendingAuthorizations()).toHaveLength(1);

    // A second request is idempotent while the first is still live.
    expect(await mcp.requestAuthorization('protected')).toMatchObject({
      outcome: 'pending',
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
      expect(mcp.listPendingAuthorizations()).toHaveLength(1),
    );
    const [pending] = mcp.listPendingAuthorizations();
    expect(mcp.cancelAuthorization(pending?.id ?? '')).toBe(true);
    expect(mcp.cancelAuthorization('unknown')).toBe(false);
    expect(mcp.listPendingAuthorizations()).toHaveLength(0);
    await mcp.close();
  });
});
