import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import {
  type RealtimeMediaClientProtocol,
  registerRealtimeMediaClient,
} from '../src/client/index.js';
import {
  type LiveKitRoomTransportDescriptor,
  REALTIME_MEDIA_EXTENSION_ID,
  type RealtimeMediaTransportDescriptor,
} from '../src/index.js';

function fakeClient(
  transport: RealtimeMediaTransportDescriptor = {
    profile: 'livekit-room',
    url: 'wss://livekit.example.com',
    token: 'secret',
  },
  resultMeta?: Record<string, unknown>,
) {
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
        return { transport, _meta: resultMeta };
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
  it('injects configured capability metadata and returns accepted credentials', async () => {
    const { client, requests } = fakeClient();
    const realtime = registerRealtimeMediaClient(client, {
      capability: {
        transports: ['livekit-room', 'websocket-pcm'],
        media: ['audio'],
      },
    });
    const result = await realtime.accept('session-1', {
      metadata: { trace: 'trace-1' },
    });
    expect(result.transport.kind).toBe('livekit-room');
    if (result.transport.kind !== 'livekit-room')
      throw new Error('Expected LiveKit transport');
    expect(result.transport.descriptor).toMatchObject({
      profile: 'livekit-room',
      url: 'wss://livekit.example.com',
      token: 'secret',
    });
    expectTypeOf(
      result.transport.descriptor,
    ).toMatchTypeOf<LiveKitRoomTransportDescriptor>();
    expect(requests[0]).toMatchObject({
      params: {
        sessionId: 'session-1',
        _meta: {
          trace: 'trace-1',
          'io.modelcontextprotocol/clientCapabilities': {
            extensions: {
              [REALTIME_MEDIA_EXTENSION_ID]: {
                transports: ['livekit-room', 'websocket-pcm'],
                media: ['audio'],
              },
            },
          },
        },
      },
    });
  });

  it('rejects malformed descriptors for known profiles', async () => {
    const { client } = fakeClient({
      profile: 'livekit-room',
      url: 'not-a-url',
      token: '',
    });
    const realtime = registerRealtimeMediaClient(client);
    await expect(realtime.accept('session-1')).rejects.toThrow();
  });

  it('preserves unknown profiles and opaque fields', async () => {
    const descriptor = {
      profile: 'websocket-pcm',
      endpoint: 'wss://media.example.com',
      vendor: { revision: 2 },
    };
    const { client } = fakeClient(descriptor, { trace: 'trace-1' });
    const result =
      await registerRealtimeMediaClient(client).accept('session-1');
    expect(result).toEqual({
      transport: { kind: 'unknown', descriptor },
      _meta: { trace: 'trace-1' },
    });
    if (result.transport.kind !== 'unknown')
      throw new Error('Expected unknown transport');
    expectTypeOf(
      result.transport.descriptor,
    ).toEqualTypeOf<RealtimeMediaTransportDescriptor>();
  });

  it('preserves extra descriptor metadata for known profiles', async () => {
    const { client } = fakeClient({
      profile: 'livekit-room',
      url: 'wss://livekit.example.com',
      token: 'secret',
      vendor: { trace: 'trace-1' },
    });
    const result =
      await registerRealtimeMediaClient(client).accept('session-1');
    expect(result.transport.descriptor).toMatchObject({
      vendor: { trace: 'trace-1' },
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
