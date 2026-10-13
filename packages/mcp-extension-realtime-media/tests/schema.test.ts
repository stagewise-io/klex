import { describe, expect, it } from 'vitest';

import {
  AcceptRealtimeMediaSessionResultSchema,
  RealtimeMediaExtensionCapabilitySchema,
  RealtimeMediaSessionContextSchema,
  RealtimeMediaSessionOfferedNotificationSchema,
} from '../src/generated/schema.js';

const capability = { transports: ['livekit-room'], media: ['audio'] } as const;

describe('Realtime Media schemas', () => {
  it('accepts non-empty profile capability lists', () => {
    expect(RealtimeMediaExtensionCapabilitySchema.parse(capability)).toEqual(
      capability,
    );
    expect(
      RealtimeMediaExtensionCapabilitySchema.safeParse({
        transports: ['websocket-pcm'],
        media: ['audio'],
      }).success,
    ).toBe(true);
    expect(
      RealtimeMediaExtensionCapabilitySchema.safeParse({
        transports: [],
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

  it('preserves generic text and nested JSON without inventing a schema', () => {
    const context = {
      text: 'Incoming session',
      metadata: { participant: { label: 'Ada', flags: [true, null, 42] } },
    };
    expect(RealtimeMediaSessionContextSchema.parse(context)).toEqual(context);
    expect(RealtimeMediaSessionContextSchema.parse({})).toEqual({});
  });

  it('enforces exact UTF-8 byte and visited-value boundaries', () => {
    const text = 'a'.repeat(4085); // {"text":""} uses 11 bytes.
    expect(RealtimeMediaSessionContextSchema.safeParse({ text }).success).toBe(
      true,
    );
    expect(
      RealtimeMediaSessionContextSchema.safeParse({ text: `${text}a` }).success,
    ).toBe(false);
    expect(
      RealtimeMediaSessionContextSchema.safeParse({
        text: `${'é'.repeat(2042)}a`,
      }).success,
    ).toBe(true);
    expect(
      RealtimeMediaSessionContextSchema.safeParse({ text: 'é'.repeat(2043) })
        .success,
    ).toBe(false);
    // Root, metadata, array, plus 125 elements = 128 values.
    expect(
      RealtimeMediaSessionContextSchema.safeParse({
        metadata: { list: Array(125).fill(null) },
      }).success,
    ).toBe(true);
    expect(
      RealtimeMediaSessionContextSchema.safeParse({
        metadata: { list: Array(126).fill(null) },
      }).success,
    ).toBe(false);
  });

  it('bounds depth before recursive parsing and rejects cycles', () => {
    let nested: unknown = null;
    for (let i = 0; i < 6; i++) nested = { value: nested };
    expect(
      RealtimeMediaSessionContextSchema.safeParse({
        metadata: { value: nested },
      }).success,
    ).toBe(true);
    expect(
      RealtimeMediaSessionContextSchema.safeParse({
        metadata: { value: { value: nested } },
      }).success,
    ).toBe(false);
    for (let i = 0; i < 10_000; i++) nested = { value: nested };
    expect(
      RealtimeMediaSessionContextSchema.safeParse({
        metadata: { value: nested },
      }).success,
    ).toBe(false);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(
      RealtimeMediaSessionContextSchema.safeParse({ metadata: cycle }).success,
    ).toBe(false);
  });

  it.each([
    null,
    [],
    { text: 1 },
    { other: 'lost fact' },
    { metadata: { x: undefined } },
    { metadata: { x: Infinity } },
    { metadata: { x: () => 'no' } },
    { metadata: { x: new Date() } },
  ])('rejects malformed context %#', (context) => {
    expect(RealtimeMediaSessionContextSchema.safeParse(context).success).toBe(
      false,
    );
  });

  it('does not invoke getters or serialization hooks', () => {
    let invoked = false;
    const metadata = Object.defineProperty({}, 'toJSON', {
      value: () => {
        invoked = true;
        return {};
      },
    });
    expect(
      RealtimeMediaSessionContextSchema.safeParse({ metadata }).success,
    ).toBe(false);
    expect(
      RealtimeMediaSessionContextSchema.safeParse({
        get text() {
          invoked = true;
          return 'no';
        },
      }).success,
    ).toBe(false);
    expect(invoked).toBe(false);
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
        transport: { profile: 'websocket-pcm', endpoint: 'opaque' },
      }).success,
    ).toBe(true);
    expect(
      AcceptRealtimeMediaSessionResultSchema.safeParse({
        transport: { profile: '' },
      }).success,
    ).toBe(false);
  });
});
