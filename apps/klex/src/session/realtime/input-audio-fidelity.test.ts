import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import type { RootLogger } from '@stagewise/logger';

import { BoundedAsyncQueue } from '@/media-transport/async-queue';
import {
  createLiveKitRoomMediaTransportConnector,
  type LiveKitSdkAudioFrame,
  type LiveKitSdkRemoteAudioTrack,
  type LiveKitSdkRoom,
} from '@/media-transport/livekit-room/livekit-room';

import { createGeminiLiveProcessorFactory } from './gemini-live/gemini-live-session';
import type { RealtimeModelSession } from './model-session';
import { createOpenAIRealtimeProcessorFactory } from './openai-realtime/openai-realtime';

class FakeSocket extends EventEmitter {
  readyState = 0;
  readonly sent: Array<Record<string, any>> = [];
  close() {
    this.readyState = 3;
  }
  terminate() {
    this.readyState = 3;
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  open() {
    this.readyState = 1;
    this.emit('open');
  }
  message(event: object) {
    this.emit('message', Buffer.from(JSON.stringify(event)));
  }
}

const noop = () => undefined;
const logging = {
  child: () => ({ warn: noop, debug: noop, info: noop, error: noop }),
} as unknown as RootLogger;

const INPUT_RATE_HZ = 48_000;
const FRAME_SAMPLES = 960;
const SEGMENT_FRAMES = 20;
const TONES_HZ = [1_000, 3_000];

/** 400 ms of 1 kHz followed by 400 ms of 3 kHz, in 20 ms LiveKit frames. */
function callerFrames(): LiveKitSdkAudioFrame[] {
  const frames: LiveKitSdkAudioFrame[] = [];
  let phase = 0;
  for (const tone of TONES_HZ)
    for (let frame = 0; frame < SEGMENT_FRAMES; frame += 1) {
      const data = new Int16Array(FRAME_SAMPLES);
      for (let index = 0; index < FRAME_SAMPLES; index += 1) {
        phase += (2 * Math.PI * tone) / INPUT_RATE_HZ;
        data[index] = Math.round(Math.sin(phase) * 12_000);
      }
      frames.push({
        data,
        sampleRate: INPUT_RATE_HZ,
        channels: 1,
        samplesPerChannel: FRAME_SAMPLES,
      });
    }
  return frames;
}

/** Zero-crossing frequency over the middle half of a segment. */
function dominantFrequency(samples: Int16Array, rateHz: number): number {
  const start = Math.floor(samples.length / 4);
  const end = Math.floor((samples.length * 3) / 4);
  let crossings = 0;
  for (let index = start + 1; index < end; index += 1)
    if (samples[index - 1]! < 0 !== samples[index]! < 0) crossings += 1;
  return (crossings / 2) * (rateHz / (end - start));
}

interface Provider {
  readonly name: string;
  open(): Promise<{
    session: RealtimeModelSession;
    sentAudio(): Buffer[];
    declaredRateHz(): number;
  }>;
}

const providers: Provider[] = [
  {
    name: 'Gemini Live',
    async open() {
      const socket = new FakeSocket();
      const created = createGeminiLiveProcessorFactory({
        logging,
        config: { modelId: 'gemini', apiKey: 'k', websocketUrl: 'wss://g' },
        connect: () => socket,
      }).create({ namespace: 'n', sessionId: 's', signal: abortless() });
      socket.open();
      socket.message({ setupComplete: {} });
      const audio = () =>
        socket.sent.flatMap((m) =>
          m.realtimeInput?.audio ? [m.realtimeInput.audio] : [],
        );
      return {
        session: await created,
        sentAudio: () => audio().map((a) => Buffer.from(a.data, 'base64')),
        declaredRateHz: () =>
          Number(/^audio\/pcm;rate=(\d+)$/.exec(audio()[0].mimeType)?.[1]),
      };
    },
  },
  {
    name: 'OpenAI Realtime',
    async open() {
      const socket = new FakeSocket();
      const created = createOpenAIRealtimeProcessorFactory({
        logging,
        config: {
          modelId: 'gpt-realtime',
          apiKey: 'k',
          websocketUrl: 'wss://o',
        },
        connect: () => socket,
      }).create({ namespace: 'n', sessionId: 's', signal: abortless() });
      socket.open();
      socket.message({ type: 'session.updated' });
      return {
        session: await created,
        sentAudio: () =>
          socket.sent
            .filter((m) => m.type === 'input_audio_buffer.append')
            .map((m) => Buffer.from(m.audio, 'base64')),
        declaredRateHz: () => {
          const format = socket.sent[0]?.session.audio.input.format;
          expect(format.type).toBe('audio/pcm');
          return format.rate;
        },
      };
    },
  },
];

function abortless(): AbortSignal {
  return new AbortController().signal;
}

async function liveKitCaller() {
  const stream = new BoundedAsyncQueue<LiveKitSdkAudioFrame>(1_000);
  let subscribe: ((track: LiveKitSdkRemoteAudioTrack) => void) | undefined;
  const room: LiveKitSdkRoom = {
    connect: async () => undefined,
    publishAudio: async () => ({
      capture: async () => undefined,
      close: async () => undefined,
    }),
    onAudioTrackSubscribed: (listener) => {
      subscribe = listener;
      return noop;
    },
    onAudioTrackUnsubscribed: () => noop,
    onDisconnected: () => noop,
    disconnect: async () => undefined,
  };
  const connector = createLiveKitRoomMediaTransportConnector({
    loadSdk: async () => ({
      createRoom: () => room,
      dispose: async () => undefined,
    }),
  });
  const transport = await connector.connect(
    { profile: 'livekit-room', url: 'wss://livekit.test', token: 't' },
    { signal: abortless() },
  );
  subscribe?.({
    id: 'microphone',
    participantId: 'caller',
    openStream: () => ({
      [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
      close: async () => stream.close(),
    }),
  });
  const next = await transport.audioSources[Symbol.asyncIterator]().next();
  if (next.done) throw new Error('No LiveKit audio source');
  return { stream, source: next.value, connector };
}

describe('realtime input audio fidelity', () => {
  it.each(providers)(
    'sends $name the caller audio at its declared rate, pitch and length',
    async (provider) => {
      const { session, sentAudio, declaredRateHz } = await provider.open();
      const caller = await liveKitCaller();
      await session.audioInputs.attach(caller.source);
      const frames = callerFrames();
      for (const frame of frames) await caller.stream.push(frame);

      const inputSeconds = (frames.length * FRAME_SAMPLES) / INPUT_RATE_HZ;
      await expect
        .poll(() => sentAudio().length, { timeout: 5_000, interval: 20 })
        .toBe(frames.length);
      const chunks = sentAudio();
      for (const chunk of chunks) expect(chunk.byteLength % 2).toBe(0);
      const pcm = Buffer.concat(chunks);
      const samples = new Int16Array(pcm.byteLength / 2);
      for (let index = 0; index < samples.length; index += 1)
        samples[index] = pcm.readInt16LE(index * 2);

      const rateHz = declaredRateHz();
      expect(samples.length / rateHz).toBeCloseTo(inputSeconds, 3);
      const segment = samples.length / TONES_HZ.length;
      TONES_HZ.forEach((tone, index) => {
        const heard = dominantFrequency(
          samples.subarray(index * segment, (index + 1) * segment),
          rateHz,
        );
        expect(Math.abs(heard - tone) / tone).toBeLessThan(0.01);
      });

      await session.close();
      await caller.connector.close();
    },
    10_000,
  );
});
