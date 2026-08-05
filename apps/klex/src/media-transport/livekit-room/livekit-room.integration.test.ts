import { randomUUID } from 'node:crypto';

import {
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  RemoteAudioTrack,
  Room,
  RoomEvent,
  AudioFrame as RtcAudioFrame,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node';
import { AccessToken } from 'livekit-server-sdk';
import { describe, expect, it } from 'vitest';

import { createLiveKitRoomMediaTransportConnector } from './livekit-room';
import { loadLiveKitSdk } from './sdk-loader';

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

function hasSignal(samples: Int16Array): boolean {
  return samples.some((sample) => Math.abs(sample) > 20);
}

function bytesToSamples(bytes: Uint8Array): Int16Array {
  const copy = bytes.slice();
  return new Int16Array(copy.buffer, copy.byteOffset, copy.byteLength / 2);
}

async function nextSignaledFrame<T>(
  iterator: AsyncIterator<T>,
  samplesFrom: (frame: T) => Int16Array,
): Promise<T> {
  try {
    for (let index = 0; index < 50; index += 1) {
      const next = await iterator.next();
      if (next.done)
        throw new Error('Audio stream ended before receiving signal');
      if (hasSignal(samplesFrom(next.value))) return next.value;
    }
    throw new Error('Audio stream produced only silence');
  } finally {
    await iterator.return?.();
  }
}

async function token(
  key: string,
  secret: string,
  room: string,
  identity: string,
): Promise<string> {
  const accessToken = new AccessToken(key, secret, {
    identity,
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

describe('LiveKitRoomMediaTransport real room', () => {
  integrationTest(
    'exchanges copied PCM frames with an independent RTC peer',
    async () => {
      const liveKitUrl = url as string;
      const key = apiKey as string;
      const secret = apiSecret as string;
      const roomName = `klex-integration-${randomUUID()}`;
      const connector = createLiveKitRoomMediaTransportConnector({
        loadSdk: loadLiveKitSdk,
      });
      const peer = new Room();
      const source = new AudioSource(48_000, 1, 100);
      const localTrack = LocalAudioTrack.createAudioTrack(
        'integration-microphone',
        source,
      );
      let peerStream: AudioStream | undefined;
      const peerTrack = new Promise<RemoteAudioTrack>((resolve) => {
        peer.on(RoomEvent.TrackSubscribed, (track) => {
          if (track instanceof RemoteAudioTrack) resolve(track);
        });
      });
      const controller = new AbortController();
      let transport: Awaited<ReturnType<typeof connector.connect>> | undefined;
      try {
        await peer.connect(
          liveKitUrl,
          await token(key, secret, roomName, 'integration-peer'),
          { autoSubscribe: true, dynacast: false },
        );
        transport = await connector.connect(
          {
            profile: 'livekit-room',
            url: liveKitUrl,
            token: await token(key, secret, roomName, 'klex-adapter'),
          },
          { signal: controller.signal },
        );
        await peer.localParticipant?.publishTrack(
          localTrack,
          new TrackPublishOptions({
            source: TrackSource.SOURCE_MICROPHONE,
          }),
        );

        const samples = Int16Array.from({ length: 960 }, (_, index) =>
          Math.round(8_000 * Math.sin((2 * Math.PI * 440 * index) / 48_000)),
        );
        const sourceResult = await timeout(
          transport.audioSources[Symbol.asyncIterator]().next(),
          10_000,
        );
        if (sourceResult.done) throw new Error('Expected remote audio source');
        expect(sourceResult.value.metadata.participantId).toBe(
          'integration-peer',
        );
        const incomingPromise = timeout(
          nextSignaledFrame(
            sourceResult.value.readable[Symbol.asyncIterator](),
            (frame) => bytesToSamples(frame.data),
          ),
          10_000,
        );
        for (let index = 0; index < 20; index += 1) {
          await source.captureFrame(new RtcAudioFrame(samples, 48_000, 1, 960));
        }
        const incoming = await incomingPromise;
        expect(incoming.data).toHaveLength(samples.byteLength);
        expect(incoming.data.buffer).not.toBe(samples.buffer);

        const remoteTrack = await timeout(peerTrack, 10_000);
        peerStream = new AudioStream(remoteTrack, {
          sampleRate: 48_000,
          numChannels: 1,
          frameSizeMs: 20,
        });
        const outbound = Uint8Array.from(new Uint8Array(samples.buffer));
        const receivedPromise = timeout(
          nextSignaledFrame(
            peerStream[Symbol.asyncIterator](),
            (frame) => frame.data,
          ),
          10_000,
        );
        for (let sequence = 1; sequence <= 20; sequence += 1) {
          await transport.audioOutput.write({
            encoding: 'pcm-s16le',
            sampleRateHz: 48_000,
            channels: 1,
            sequence,
            timestampUs: (sequence - 1) * 20_000,
            data: Uint8Array.from(outbound),
          });
        }
        const received = await receivedPromise;
        expect(received.data).toHaveLength(samples.length);
      } finally {
        controller.abort();
        await peerStream?.cancel();
        source.clearQueue();
        await Promise.allSettled([
          localTrack.close(false),
          source.close(),
          peer.disconnect(),
          transport?.close(),
        ]);
        await connector.close();
      }
    },
    20_000,
  );
});
