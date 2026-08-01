import { describe, expect, it } from 'vitest';

import {
  AcceptRealtimeMediaSessionResultSchema,
  RealtimeMediaExtensionCapabilitySchema,
  RealtimeMediaSessionOfferedNotificationSchema,
} from '../src/generated/schema.js';

const capability = { transports: ['livekit-room'], media: ['audio'] } as const;

describe('Realtime Media schemas', () => {
  it('accepts the locked capability and rejects unsupported profiles', () => {
    expect(RealtimeMediaExtensionCapabilitySchema.parse(capability)).toEqual(
      capability,
    );
    expect(
      RealtimeMediaExtensionCapabilitySchema.safeParse({
        transports: ['websocket-pcm'],
        media: ['audio'],
      }).success,
    ).toBe(false);
  });

  it('accepts an offer without transport credentials', () => {
    const notification = {
      jsonrpc: '2.0',
      method: 'io.stagewise/realtime-media/session-offered',
      params: {
        sessionId: 'session-1',
        expiresAt: '2026-08-01T18:00:00.000Z',
      },
    };
    expect(
      RealtimeMediaSessionOfferedNotificationSchema.parse(notification),
    ).toEqual(notification);
    expect(JSON.stringify(notification)).not.toContain('token');
  });

  it('validates accepted transport credentials', () => {
    expect(
      AcceptRealtimeMediaSessionResultSchema.parse({
        transport: {
          profile: 'livekit-room',
          url: 'wss://livekit.example.com',
          token: 'secret',
        },
      }),
    ).toBeDefined();
    expect(
      AcceptRealtimeMediaSessionResultSchema.safeParse({
        transport: { profile: 'livekit-room', url: 'invalid', token: '' },
      }).success,
    ).toBe(false);
  });
});
