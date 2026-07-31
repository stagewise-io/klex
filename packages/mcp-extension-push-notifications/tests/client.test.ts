import { describe, expect, it, vi } from 'vitest';

import {
  type PushNotificationsClientProtocol,
  registerPushNotificationsClient,
} from '../src/client/index.js';
import { PUSH_NOTIFICATIONS_EXTENSION_ID } from '../src/index.js';

const event = {
  eventId: 'event-1',
  sourceId: 'computer:local',
  type: 'process.exited',
  createdAt: '2026-07-20T10:30:00.000Z',
  payload: { exitCode: 1 },
};

function fakeClient(
  options: {
    era?: 'legacy' | 'modern';
    capabilities?: Record<string, unknown>;
  } = {},
) {
  const handlers = new Map<string, (value: unknown) => unknown>();
  const requests: unknown[] = [];
  const client = {
    registerCapabilities: vi.fn(),
    assertCanSetRequestHandler: vi.fn(),
    setNotificationHandler: vi.fn((method, _schema, handler) => {
      if (handlers.has(method)) throw new Error('duplicate');
      handlers.set(method, handler);
    }),
    request: vi.fn(async (request) => {
      requests.push(request);
      const method = (request as { method: string }).method;
      if (method === 'server/discover') {
        return {
          capabilities: {
            extensions: { [PUSH_NOTIFICATIONS_EXTENSION_ID]: {} },
          },
        };
      }
      if (method === 'subscriptions/listen') {
        await handlers.get('notifications/subscriptions/acknowledged')?.({
          notifications: {
            [PUSH_NOTIFICATIONS_EXTENSION_ID]: {},
          },
        });
        return new Promise(() => undefined);
      }
      if (method === 'io.stagewise/push-notifications/get') {
        return { events: [event], hasMore: false };
      }
      return {};
    }),
    getProtocolEra: () => options.era,
    getServerCapabilities: vi.fn(
      () =>
        options.capabilities ?? {
          extensions: { [PUSH_NOTIFICATIONS_EXTENSION_ID]: {} },
        },
    ),
  } as unknown as PushNotificationsClientProtocol;
  return { client, handlers, requests };
}

describe('Push Notifications client', () => {
  it('injects per-request capability while preserving metadata', async () => {
    const { client, requests } = fakeClient();
    const klex = registerPushNotificationsClient(client);
    await klex.getEvents({ limit: 10 }, { metadata: { trace: 'trace-1' } });
    expect(requests[0]).toMatchObject({
      params: {
        limit: 10,
        _meta: {
          trace: 'trace-1',
          'io.modelcontextprotocol/clientCapabilities': {
            extensions: { [PUSH_NOTIFICATIONS_EXTENSION_ID]: {} },
          },
        },
      },
    });
  });

  it('exposes subscription closure after acknowledgement', async () => {
    const { client, requests } = fakeClient();
    const klex = registerPushNotificationsClient(client);
    expect(await klex.serverSupportsPushNotifications()).toBe(true);
    const subscription = await klex.listen(undefined, {
      request: { timeout: 5_000 },
    });
    expect(subscription.closed).toBeInstanceOf(Promise);
    expect(klex.acknowledgedSubscription()).toEqual({});
    const listenRequests = requests.filter(
      (request) =>
        (request as { method?: string }).method === 'subscriptions/listen',
    );
    expect(listenRequests).toHaveLength(1);
    expect(client.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'subscriptions/listen',
        params: expect.objectContaining({
          notifications: {
            [PUSH_NOTIFICATIONS_EXTENSION_ID]: {},
          },
        }),
      }),
      expect.anything(),
      expect.objectContaining({
        timeout: 5_000,
        resetTimeoutOnProgress: true,
        onprogress: expect.any(Function),
      }),
    );
  });

  it('uses established modern capabilities without rediscovery', async () => {
    const { client, requests } = fakeClient({ era: 'modern' });
    const klex = registerPushNotificationsClient(client);
    expect(await klex.serverSupportsPushNotifications()).toBe(true);
    expect(
      requests.filter(
        (request) =>
          (request as { method: string }).method === 'server/discover',
      ),
    ).toHaveLength(0);
  });

  it('returns false for unsupported legacy servers without discovery', async () => {
    const { client, requests } = fakeClient({
      era: 'legacy',
      capabilities: {},
    });
    const klex = registerPushNotificationsClient(client);
    expect(await klex.serverSupportsPushNotifications()).toBe(false);
    expect(requests).toHaveLength(0);
  });

  it('uses advertised support for legacy servers without discovery', async () => {
    const { client, requests } = fakeClient({ era: 'legacy' });
    const klex = registerPushNotificationsClient(client);
    expect(await klex.serverSupportsPushNotifications()).toBe(true);
    expect(requests).toHaveLength(0);
  });

  it('caches lazy discovery before protocol state is available', async () => {
    const { client, requests } = fakeClient({ capabilities: undefined });
    vi.mocked(client.getServerCapabilities).mockReturnValue(undefined);
    const klex = registerPushNotificationsClient(client);
    await Promise.all([
      klex.serverSupportsPushNotifications(),
      klex.serverSupportsPushNotifications(),
    ]);
    expect(
      requests.filter(
        (request) =>
          (request as { method: string }).method === 'server/discover',
      ),
    ).toHaveLength(1);
  });

  it('does not acknowledge received events automatically', async () => {
    const { client, handlers } = fakeClient();
    const onEvent = vi.fn();
    registerPushNotificationsClient(client, { onEvent });
    await handlers.get('io.stagewise/push-notifications/event')?.({ event });
    expect(onEvent).toHaveBeenCalledOnce();
    expect(client.request).not.toHaveBeenCalled();
  });

  it('rejects duplicate notification registration', () => {
    const { client } = fakeClient();
    registerPushNotificationsClient(client);
    expect(() => registerPushNotificationsClient(client)).toThrow('duplicate');
  });
});
