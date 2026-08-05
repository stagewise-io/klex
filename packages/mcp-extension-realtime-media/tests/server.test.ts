import { describe, expect, it, vi } from 'vitest';

import { withRealtimeMediaClientCapability } from '../src/capabilities.js';
import {
  RealtimeMediaProtocolError,
  type RealtimeMediaServerProtocol,
  realtimeMediaSessionError,
  registerRealtimeMediaServer,
} from '../src/index.js';

function fakeServer() {
  const handlers = new Map<
    string,
    (params: never, context: never) => unknown
  >();
  const server = {
    registerCapabilities: vi.fn(),
    setRequestHandler: vi.fn((method, _schema, handler) => {
      handlers.set(method, handler);
    }),
    notification: vi.fn(),
    getClientCapabilities: vi.fn(),
  } as unknown as RealtimeMediaServerProtocol;
  return { server, handlers };
}

const context = {
  mcpReq: { envelope: withRealtimeMediaClientCapability({}) },
} as never;

describe('Realtime Media server', () => {
  it('validates capability and delegates lifecycle handlers', async () => {
    const { server, handlers } = fakeServer();
    const accept = vi.fn(() => ({
      transport: {
        profile: 'livekit-room' as const,
        url: 'wss://livekit.example.com',
        token: 'secret',
      },
    }));
    registerRealtimeMediaServer(server, {
      accept,
      reject: vi.fn(),
      end: vi.fn(),
    });
    await expect(
      handlers.get('io.stagewise/realtime-media/accept')?.(
        { sessionId: 'session-1' } as never,
        context,
      ),
    ).resolves.toMatchObject({ transport: { profile: 'livekit-room' } });
    expect(accept).toHaveBeenCalledOnce();
  });

  it('rejects requests without a compatible client capability', async () => {
    const { server, handlers } = fakeServer();
    registerRealtimeMediaServer(server, {
      accept: vi.fn(),
      reject: vi.fn(),
      end: vi.fn(),
    });
    await expect(
      handlers.get('io.stagewise/realtime-media/reject')?.(
        { sessionId: 'session-1' } as never,
        {
          mcpReq: {
            envelope: withRealtimeMediaClientCapability(
              {},
              { transports: ['websocket-pcm'], media: ['audio'] },
            ),
          },
        } as never,
      ),
    ).rejects.toBeInstanceOf(RealtimeMediaProtocolError);
  });

  it('creates typed session errors without credentials', () => {
    const error = realtimeMediaSessionError('expired-offer', 'session-1');
    expect(error).toMatchObject({ code: -32_021 });
    expect(JSON.stringify(error.data)).not.toContain('token');
  });
});
