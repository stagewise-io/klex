import { randomUUID } from 'node:crypto';

import {
  LocalVideoTrack,
  Room,
  TrackPublishOptions,
  TrackSource,
  VideoBufferType,
  VideoFrame,
  VideoSource,
} from '@livekit/rtc-node';
import { AccessToken } from 'livekit-server-sdk';
import { describe, expect, it } from 'vitest';

import type { ModuleLogger } from '@stagewise/logger';

import type { EncodedImageFrame } from '@/session/realtime/model-session';
import { createRealtimeVisionForCall } from '@/session/realtime/vision';

import { createLiveKitRoomMediaTransportConnector } from './livekit-room';
import { loadLiveKitSdk } from './sdk-loader';

// rtc-node's dispose() is process-global, so each real-room test file holds
// one test: vitest runs each file in its own worker.
const url = process.env.LIVEKIT_URL;
const apiKey = process.env.LIVEKIT_API_KEY;
const apiSecret = process.env.LIVEKIT_API_SECRET;
const integrationTest = url && apiKey && apiSecret ? it : it.skip;

function timeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      setTimeout(
        () => reject(new Error('LiveKit integration timeout')),
        milliseconds,
      );
    }),
  ]);
}

async function token(
  key: string,
  secret: string,
  room: string,
  identity: string,
): Promise<string> {
  const accessToken = new AccessToken(key, secret, {
    identity,
    name: identity === 'integration-peer' ? 'Dana' : undefined,
    ttl: '2m',
  });
  accessToken.addGrant({
    room,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
  });
  return accessToken.toJwt();
}

describe('LiveKitRoomMediaTransport real room tiling', () => {
  integrationTest(
    'tiles a screen share and a camera side by side',
    async () => {
      const liveKitUrl = url as string;
      const key = apiKey as string;
      const secret = apiSecret as string;
      const roomName = `klex-integration-${randomUUID()}`;
      const connector = createLiveKitRoomMediaTransportConnector({
        loadSdk: loadLiveKitSdk,
      });
      const peer = new Room();
      const sources = [
        { name: 'screen', source: TrackSource.SOURCE_SCREENSHARE, shade: 220 },
        { name: 'camera', source: TrackSource.SOURCE_CAMERA, shade: 40 },
      ].map(({ name, source, shade }) => {
        const video = new VideoSource(320, 180);
        return {
          source,
          video,
          track: LocalVideoTrack.createVideoTrack(`integration-${name}`, video),
          pixels: new Uint8Array(320 * 180 * 4).fill(shade),
        };
      });
      const controller = new AbortController();
      let transport: Awaited<ReturnType<typeof connector.connect>> | undefined;
      let capturing = true;
      const capture = (async () => {
        while (capturing) {
          for (const { video, pixels } of sources)
            video.captureFrame(
              new VideoFrame(pixels, 320, 180, VideoBufferType.RGBA),
            );
          await new Promise((resolve) => setTimeout(resolve, 33));
        }
      })();
      try {
        await peer.connect(
          liveKitUrl,
          await token(key, secret, roomName, 'integration-peer'),
          { autoSubscribe: true, dynacast: false },
        );
        for (const { track, source } of sources)
          await peer.localParticipant?.publishTrack(
            track,
            new TrackPublishOptions({ source }),
          );
        transport = await connector.connect(
          {
            profile: 'livekit-room',
            url: liveKitUrl,
            token: await token(key, secret, roomName, 'klex-adapter'),
          },
          { signal: controller.signal },
        );
        if (!transport.videoSources)
          throw new Error('Expected video discovery');

        const stills: EncodedImageFrame[] = [];
        const descriptions: string[] = [];
        let tiled!: () => void;
        const sideBySide = new Promise<void>((resolve) => {
          tiled = resolve;
        });
        const vision = createRealtimeVisionForCall({
          logger: {
            debug: () => undefined,
            info: () => undefined,
            warn: () => undefined,
          } as unknown as ModuleLogger,
          sources: transport.videoSources,
          input: {
            maxFps: 1,
            async write(still) {
              stills.push(still);
              if (still.width === 1024) tiled();
            },
            async describe(text) {
              descriptions.push(text);
            },
          },
        });
        if (!vision) throw new Error('Expected sharp-backed vision');
        void vision.run();
        await timeout(sideBySide, 15_000).finally(() => vision.close());
        expect(stills.at(-1)).toMatchObject({
          mimeType: 'image/jpeg',
          width: 1024,
          height: 288,
          detail: 'high',
        });
        expect(descriptions.at(-1)).toContain(
          "left: Dana's screen; right: Dana's camera.",
        );
      } finally {
        capturing = false;
        await capture;
        controller.abort();
        await Promise.allSettled([
          ...sources.flatMap(({ track, video }) => [
            track.close(false),
            video.close(),
          ]),
          peer.disconnect(),
          transport?.close(),
        ]);
        await connector.close();
      }
    },
    30_000,
  );
});
