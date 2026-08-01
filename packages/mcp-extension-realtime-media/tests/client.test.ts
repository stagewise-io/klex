import { describe, expect, it, vi } from 'vitest';

import {
  type RealtimeMediaClientProtocol,
  registerRealtimeMediaClient,
} from '../src/client/index.js';
import { REALTIME_MEDIA_EXTENSION_ID } from '../src/index.js';

function fakeClient() {
  const handlers = new Map<string, (value: never) => unknown>();
  const requests: unknown[] = [];
  const capability = {
    transports: ['livekit-room'],
    media: ['audio'],
  };
  const client = {
    registerCapabilities: vi.fn(),
    setNotificationHandler: vi.fn((method, _schema, handler) => {
      handlers.set(method, handler);
    }),
    request: vi.fn(async (request) => {
      requests.push(request);
      const method = (request as { method: string }).method;
      if (method === 'subscriptions/listen') {
        await handlers.get('notifications/subscriptions/acknowledged')?.({
          notifications: { [REALTIME_MEDIA_EXTENSION_ID]: {} },
        } as never);
        return new Promise(() => undefined);
      }
      if (method.endsWith('/accept')) {
        return {
          transport: {
            profile: 'livekit-room',
            url: 'wss://livekit.example.com',
            token: 'secret',
          },
        };
      }
      return {};
    }),
    getProtocolEra: () => 'modern',
    getServerCapabilities: () => ({
      extensions: { [REALTIME_MEDIA_EXTENSION_ID]: capability },
    }),
  } as unknown as RealtimeMediaClientProtocol;
  return { client, handlers, requests };
}

describe('Realtime Media client', () => {
  it('injects capability metadata and returns accepted credentials', async () => {
    const { client, requests } = fakeClient();
    const realtime = registerRealtimeMediaClient(client);
    const result = await realtime.accept('session-1', {
      metadata: { trace: 'trace-1' },
    });
    expect(result.transport.profile).toBe('livekit-room');
    expect(requests[0]).toMatchObject({
      params: {
        sessionId: 'session-1',
        _meta: {
          trace: 'trace-1',
          'io.modelcontextprotocol/clientCapabilities': {
            extensions: {
              [REALTIME_MEDIA_EXTENSION_ID]: {
                transports: ['livekit-room'],
                media: ['audio'],
              },
            },
          },
        },
      },
    });
  });

  it('opens a generic subscription and forwards both notifications', async () => {
    const { client, handlers, requests } = fakeClient();
    const onNotification = vi.fn();
    const realtime = registerRealtimeMediaClient(client, { onNotification });
    const subscription = await realtime.listen();
    expect(subscription.closed).toBeInstanceOf(Promise);
    expect(requests[0]).toMatchObject({
      method: 'subscriptions/listen',
      params: { notifications: { [REALTIME_MEDIA_EXTENSION_ID]: {} } },
    });
    await handlers.get('io.stagewise/realtime-media/session-offered')?.({
      sessionId: 'session-1',
      expiresAt: '2026-08-01T18:00:00.000Z',
    } as never);
    await handlers.get('io.stagewise/realtime-media/session-ended')?.({
      sessionId: 'session-1',
      reason: 'remote',
    } as never);
    expect(onNotification).toHaveBeenCalledTimes(2);
  });
});
