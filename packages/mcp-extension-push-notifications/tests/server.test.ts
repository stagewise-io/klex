import { describe, expect, it, vi } from 'vitest';

import {
  PUSH_NOTIFICATIONS_EXTENSION_ID,
  PushNotificationsProtocolError,
  type PushNotificationsServerProtocol,
  registerPushNotificationsServer,
  withPushNotificationsClientCapability,
} from '../src/index.js';

function fakeServer(initializationSupport = false) {
  const handlers = new Map<
    string,
    (value: unknown, context: object) => unknown
  >();
  const notifications: unknown[] = [];
  const server = {
    registerCapabilities: vi.fn(),
    assertCanSetRequestHandler: vi.fn(),
    setRequestHandler: vi.fn((method, _schema, handler) => {
      if (handlers.has(method)) throw new Error('duplicate');
      handlers.set(method, handler);
    }),
    notification: vi.fn(async (notification) => {
      notifications.push(notification);
    }),
    getClientCapabilities: () =>
      initializationSupport
        ? { extensions: { [PUSH_NOTIFICATIONS_EXTENSION_ID]: {} } }
        : undefined,
  } as unknown as PushNotificationsServerProtocol;
  return { server, handlers, notifications };
}

const metadata = withPushNotificationsClientCapability({});

describe('Push Notifications server', () => {
  it('requires per-request capability by default', async () => {
    const { server, handlers } = fakeServer(true);
    registerPushNotificationsServer(server, {
      getEvents: () => ({ events: [], hasMore: false }),
      acknowledgeEvents: () => undefined,
    });
    await expect(
      handlers.get('io.stagewise/push-notifications/get')?.({}, {}),
    ).rejects.toMatchObject({
      code: -32003,
      data: {
        requiredCapabilities: {
          extensions: { [PUSH_NOTIFICATIONS_EXTENSION_ID]: {} },
        },
      },
    });
  });

  it('supports explicit initialization fallback compatibility', async () => {
    const { server, handlers } = fakeServer(true);
    registerPushNotificationsServer(
      server,
      {
        getEvents: () => ({
          events: [],
          hasMore: false,
        }),
        acknowledgeEvents: () => undefined,
      },
      { acceptInitializationCapabilities: true },
    );
    await expect(
      handlers.get('io.stagewise/push-notifications/get')?.({}, {}),
    ).resolves.toEqual({
      events: [],
      hasMore: false,
    });
  });

  it('keeps durability and acknowledgement in application handlers', async () => {
    const { server, handlers } = fakeServer();
    const getEvents = vi.fn(() => ({
      events: [],
      hasMore: false,
    }));
    const acknowledgeEvents = vi.fn();
    registerPushNotificationsServer(server, { getEvents, acknowledgeEvents });
    const context = {
      mcpReq: {
        envelope: metadata,
      },
    };
    await handlers.get('io.stagewise/push-notifications/get')?.(
      { limit: 10, _meta: metadata },
      context,
    );
    await handlers.get('io.stagewise/push-notifications/ack')?.(
      { eventIds: ['event-1'], _meta: metadata },
      context,
    );
    expect(getEvents).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 10 }),
      context,
    );
    expect(acknowledgeEvents).toHaveBeenCalledWith(
      expect.objectContaining({ eventIds: ['event-1'] }),
      context,
    );
  });

  it('rejects a push without negotiated client support', async () => {
    const { server } = fakeServer();
    const klex = registerPushNotificationsServer(server, {
      getEvents: () => ({ events: [], hasMore: false }),
      acknowledgeEvents: () => undefined,
    });
    await expect(
      klex.sendEvent({
        event: {
          eventId: 'event-1',
          sourceId: 'computer:local',
          type: 'file.changed',
          createdAt: '2026-07-20T10:30:00.000Z',
          content: [],
        },
      }),
    ).rejects.toBeInstanceOf(PushNotificationsProtocolError);
  });
});
