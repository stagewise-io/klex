import { randomUUID } from 'node:crypto';

import {
  AudioSource,
  LocalAudioTrack,
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

import type { VideoSourceDescriptor } from '@/media-transport';
import type { EncodedImageFrame } from '@/session/realtime/model-session';
import { createRealtimeVisionForCall } from '@/session/realtime/vision';

import { createLiveKitRoomMediaTransportConnector } from './livekit-room';
import { loadLiveKitSdk } from './sdk-loader';

// rtc-node's dispose() is process-global, so this lives apart from the audio
// integration test: vitest runs each file in its own worker.
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

describe('LiveKitRoomMediaTransport real room video', () => {
  integrationTest(
    'subscribes to existing microphones and decodes an opened screen share',
    async () => {
      const liveKitUrl = url as string;
      const key = apiKey as string;
      const secret = apiSecret as string;
      const roomName = `klex-integration-${randomUUID()}`;
      const connector = createLiveKitRoomMediaTransportConnector({
        loadSdk: loadLiveKitSdk,
      });
      const peer = new Room();
      const audioSource = new AudioSource(48_000, 1, 100);
      const audioTrack = LocalAudioTrack.createAudioTrack(
        'integration-microphone',
        audioSource,
      );
      const videoSource = new VideoSource(320, 180);
      const videoTrack = LocalVideoTrack.createVideoTrack(
        'integration-screen',
        videoSource,
      );
      const controller = new AbortController();
      let transport: Awaited<ReturnType<typeof connector.connect>> | undefined;
      let capturing = true;
      const pixels = new Uint8Array(320 * 180 * 4).fill(200);
      const capture = (async () => {
        while (capturing) {
          videoSource.captureFrame(
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
        await peer.localParticipant?.publishTrack(
          audioTrack,
          new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
        );
        const screen = await peer.localParticipant?.publishTrack(
          videoTrack,
          new TrackPublishOptions({ source: TrackSource.SOURCE_SCREENSHARE }),
        );

        transport = await connector.connect(
          {
            profile: 'livekit-room',
            url: liveKitUrl,
            token: await token(key, secret, roomName, 'klex-adapter'),
          },
          { signal: controller.signal },
        );
        const audio = await timeout(
          transport.audioSources[Symbol.asyncIterator]().next(),
          10_000,
        );
        expect(audio.done).toBe(false);

        const videoSources = transport.videoSources;
        if (!videoSources) throw new Error('Expected video discovery');
        const discovered = await timeout(
          videoSources[Symbol.asyncIterator]().next(),
          10_000,
        );
        if (discovered.done) throw new Error('Expected a video descriptor');
        const descriptor = discovered.value;
        expect(descriptor.metadata).toMatchObject({
          participantId: 'integration-peer',
          displayName: 'Dana',
          kind: 'screenshare',
        });

        const opened = descriptor.open({ maxFps: 4 });
        const frame = await timeout(
          opened.readable[Symbol.asyncIterator]().next(),
          10_000,
        );
        if (frame.done) throw new Error('Expected a decoded frame');
        expect(frame.value).toMatchObject({
          encoding: 'rgba',
          width: 320,
          height: 180,
          rotation: 0,
        });
        expect(frame.value.data).toHaveLength(320 * 180 * 4);
        await opened.close();

        // Reopen through the vision lane: resubscribe, sample, encode JPEG.
        const stills: EncodedImageFrame[] = [];
        const descriptions: string[] = [];
        let stillWritten!: () => void;
        const firstStill = new Promise<void>((resolve) => {
          stillWritten = resolve;
        });
        const vision = createRealtimeVisionForCall({
          logger: {
            debug: () => undefined,
            info: () => undefined,
            warn: () => undefined,
          } as unknown as ModuleLogger,
          sources: (async function* (): AsyncGenerator<VideoSourceDescriptor> {
            yield descriptor;
            await descriptor.closed;
          })(),
          input: {
            maxFps: 1,
            async write(still) {
              stills.push(still);
              stillWritten();
            },
            async describe(text) {
              descriptions.push(text);
            },
          },
        });
        if (!vision) throw new Error('Expected sharp-backed vision');
        void vision.run();
        await timeout(firstStill, 10_000).finally(() => vision.close());
        expect(descriptions[0]).toContain("You now see Dana's screen");
        expect(stills[0]).toMatchObject({
          mimeType: 'image/jpeg',
          width: 320,
          height: 180,
          detail: 'high',
        });
        expect([...(stills[0]?.data.subarray(0, 2) ?? [])]).toEqual([
          0xff, 0xd8,
        ]);

        if (screen?.sid)
          await peer.localParticipant?.unpublishTrack(screen.sid);
        await expect(timeout(descriptor.closed, 10_000)).resolves.toEqual({
          type: 'closed',
          reason: 'track-unpublished',
        });
      } finally {
        capturing = false;
        await capture;
        controller.abort();
        audioSource.clearQueue();
        await Promise.allSettled([
          audioTrack.close(false),
          audioSource.close(),
          videoTrack.close(false),
          videoSource.close(),
          peer.disconnect(),
          transport?.close(),
        ]);
        await connector.close();
      }
    },
    30_000,
  );
});
