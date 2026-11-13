import { describe, expect, it } from 'vitest';

import {
  hasPerRequestRealtimeMediaCapability,
  hasRealtimeMediaCapability,
  realtimeMediaCapabilities,
  realtimeMediaExtensionCapability,
  realtimeMediaVideoNegotiated,
  withRealtimeMediaClientCapability,
} from '../src/index.js';

describe('Realtime Media capabilities', () => {
  it('advertises the locked transport and media kind', () => {
    expect(realtimeMediaCapabilities()).toEqual({
      extensions: {
        'io.stagewise/realtime-media': {
          transports: ['livekit-room'],
          media: ['audio'],
        },
      },
    });
    expect(hasRealtimeMediaCapability(realtimeMediaCapabilities())).toBe(true);
  });

  it('requires an intersecting transport profile', () => {
    const remote = realtimeMediaCapabilities({
      transports: ['websocket-pcm'],
      media: ['audio'],
    });
    expect(
      hasRealtimeMediaCapability(remote, {
        transports: ['livekit-room'],
        media: ['audio'],
      }),
    ).toBe(false);
    expect(
      hasRealtimeMediaCapability(remote, {
        transports: ['websocket-pcm', 'livekit-room'],
        media: ['audio'],
      }),
    ).toBe(true);
  });

  it('treats video as an optional kind next to required audio', () => {
    const video = realtimeMediaExtensionCapability(['livekit-room'], {
      video: true,
    });
    const audio = realtimeMediaExtensionCapability();
    expect(video.media).toEqual(['audio', 'video']);
    expect(
      hasRealtimeMediaCapability(realtimeMediaCapabilities(video), audio),
    ).toBe(true);
    expect(
      hasRealtimeMediaCapability(realtimeMediaCapabilities(audio), video),
    ).toBe(true);
    expect(
      hasRealtimeMediaCapability(
        realtimeMediaCapabilities({
          transports: ['livekit-room'],
          media: ['video'],
        }),
      ),
    ).toBe(false);
    expect(realtimeMediaVideoNegotiated(video, video)).toBe(true);
    expect(realtimeMediaVideoNegotiated(video, audio)).toBe(false);
    expect(
      realtimeMediaVideoNegotiated(video, {
        transports: ['livekit-room'],
        media: ['audio', 'hologram', 'video'],
      }),
    ).toBe(true);
  });

  it('merges per-request capability metadata', () => {
    const metadata = withRealtimeMediaClientCapability({ trace: 'trace-1' });
    expect(metadata.trace).toBe('trace-1');
    expect(hasPerRequestRealtimeMediaCapability(metadata)).toBe(true);
  });
});
