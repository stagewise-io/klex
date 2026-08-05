import { describe, expect, it, vi } from 'vitest';

import { BoundedAsyncQueue } from '../async-queue';
import type { AudioFrame, AudioSource } from '../media-transport';
import {
  createLiveKitRoomMediaTransportConnector,
  type LiveKitSdk,
  type LiveKitSdkAudioFrame,
  type LiveKitSdkAudioPublisher,
  type LiveKitSdkAudioStream,
  type LiveKitSdkRemoteAudioTrack,
  type LiveKitSdkRoom,
} from './livekit-room';

const descriptor = {
  profile: 'livekit-room',
  url: 'wss://livekit.example.test',
  token: 'token',
} as const;

class FakeStream implements LiveKitSdkAudioStream {
  private readonly queue = new BoundedAsyncQueue<LiveKitSdkAudioFrame>(32);
  close = vi.fn(async () => this.queue.close());
  yielded = 0;

  push(frame: LiveKitSdkAudioFrame): Promise<void> {
    return this.queue.push(frame);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<LiveKitSdkAudioFrame> {
    for await (const frame of this.queue) {
      this.yielded += 1;
      yield frame;
    }
  }
}

class FakeTrack implements LiveKitSdkRemoteAudioTrack {
  readonly stream = new FakeStream();
  openStream = vi.fn(() => this.stream);

  constructor(
    readonly id: string,
    readonly participantId = `participant-${id}`,
  ) {}
}

class FakePublisher implements LiveKitSdkAudioPublisher {
  capture = vi.fn(async () => undefined);
  close = vi.fn(async () => undefined);
}

class FakeRoom implements LiveKitSdkRoom {
  readonly publisher = new FakePublisher();
  readonly subscribed = new Set<(track: LiveKitSdkRemoteAudioTrack) => void>();
  readonly unsubscribed = new Set<
    (track: LiveKitSdkRemoteAudioTrack) => void
  >();
  readonly disconnected = new Set<(reason: string) => void>();
  connect: LiveKitSdkRoom['connect'] = vi.fn(async () => undefined);
  publishAudio = vi.fn(async () => this.publisher);
  disconnect = vi.fn(async () => undefined);

  onAudioTrackSubscribed(
    listener: (track: LiveKitSdkRemoteAudioTrack) => void,
  ) {
    this.subscribed.add(listener);
    return () => this.subscribed.delete(listener);
  }

  onAudioTrackUnsubscribed(
    listener: (track: LiveKitSdkRemoteAudioTrack) => void,
  ) {
    this.unsubscribed.add(listener);
    return () => this.unsubscribed.delete(listener);
  }

  onDisconnected(listener: (reason: string) => void) {
    this.disconnected.add(listener);
    return () => this.disconnected.delete(listener);
  }

  emitSubscribed(track: LiveKitSdkRemoteAudioTrack): void {
    for (const listener of this.subscribed) listener(track);
  }

  emitUnsubscribed(track: LiveKitSdkRemoteAudioTrack): void {
    for (const listener of this.unsubscribed) listener(track);
  }

  emitDisconnected(reason: string): void {
    for (const listener of this.disconnected) listener(reason);
  }
}

function setup(room = new FakeRoom()) {
  const sdk: LiveKitSdk = {
    createRoom: vi.fn(() => room),
    dispose: vi.fn(async () => undefined),
  };
  const loadSdk = vi.fn(async () => sdk);
  const connector = createLiveKitRoomMediaTransportConnector({ loadSdk });
  return { room, sdk, loadSdk, connector };
}

function rtcFrame(value = 1): LiveKitSdkAudioFrame {
  return {
    data: new Int16Array([value, -value]),
    sampleRate: 48_000,
    channels: 1,
    samplesPerChannel: 2,
  };
}

function mediaFrame(overrides: Partial<AudioFrame> = {}): AudioFrame {
  return {
    encoding: 'pcm-s16le',
    sampleRateHz: 48_000,
    channels: 1,
    sequence: 0,
    timestampUs: 0,
    data: new Uint8Array(new Int16Array([1, -1]).buffer),
    ...overrides,
  };
}

async function nextSource(transport: {
  audioSources: AsyncIterable<AudioSource>;
}) {
  const result = await transport.audioSources[Symbol.asyncIterator]().next();
  if (result.done) throw new Error('Expected an audio source');
  return result.value;
}

async function nextFrame(source: {
  readable: AsyncIterable<AudioFrame>;
}): Promise<AudioFrame> {
  const result = await source.readable[Symbol.asyncIterator]().next();
  if (result.done) throw new Error('Expected an audio frame');
  return result.value;
}

describe('LiveKitRoomMediaTransportConnector', () => {
  it('validates descriptors before loading the native SDK', async () => {
    const { connector, loadSdk } = setup();
    await expect(
      connector.connect(
        { profile: 'livekit-room', url: 'not-a-url', token: '' },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow();
    expect(loadSdk).not.toHaveBeenCalled();
  });

  it('connects, publishes mono 48 kHz audio, and converts inbound frames', async () => {
    const { connector, room } = setup();
    const transport = await connector.connect(descriptor, {
      signal: new AbortController().signal,
    });
    expect(room.connect).toHaveBeenCalledWith(descriptor.url, descriptor.token);
    expect(room.publishAudio).toHaveBeenCalledWith({
      sampleRate: 48_000,
      channels: 1,
      queueSizeMs: 200,
    });

    const firstTrack = new FakeTrack('first');
    const secondTrack = new FakeTrack('second');
    room.emitSubscribed(firstTrack);
    room.emitSubscribed(secondTrack);
    const firstSource = await nextSource(transport);
    const secondSource = await nextSource(transport);
    expect(firstSource.metadata).toEqual({
      participantId: 'participant-first',
      trackId: 'first',
    });
    expect(secondSource.metadata.trackId).toBe('second');
    const source = rtcFrame(7);
    await firstTrack.stream.push(source);
    const incoming = await nextFrame(firstSource);
    expect(incoming).toMatchObject({
      encoding: 'pcm-s16le',
      sampleRateHz: 48_000,
      channels: 1,
      sequence: 0,
    });
    expect(incoming.data).toEqual(new Uint8Array(source.data.buffer));
    expect(incoming.data.buffer).not.toBe(source.data.buffer);
    expect(secondTrack.openStream).toHaveBeenCalledOnce();

    await transport.audioOutput.write(mediaFrame());
    expect(room.publisher.capture).toHaveBeenCalledWith(
      expect.any(Int16Array),
      2,
    );
    await transport.close();
    await expect(transport.closed).resolves.toEqual({
      type: 'closed',
      reason: 'local-close',
    });
    expect(room.publisher.close).toHaveBeenCalledOnce();
    expect(room.disconnect).toHaveBeenCalledOnce();
  });

  it('releases an unsubscribed active track and accepts a later track', async () => {
    const { connector, room } = setup();
    const transport = await connector.connect(descriptor, {
      signal: new AbortController().signal,
    });
    const first = new FakeTrack('first');
    const second = new FakeTrack('second');
    room.emitSubscribed(first);
    const firstSource = await nextSource(transport);
    room.emitUnsubscribed(first);
    await expect(firstSource.closed).resolves.toMatchObject({ type: 'closed' });
    room.emitSubscribed(second);
    const secondSource = await nextSource(transport);
    await second.stream.push(rtcFrame(2));
    expect((await nextFrame(secondSource)).sequence).toBe(0);
    expect(first.stream.close).toHaveBeenCalledOnce();
    await transport.close();
  });

  it('fails safely when an unsubscribed stream cannot close', async () => {
    const { connector, room } = setup();
    const transport = await connector.connect(descriptor, {
      signal: new AbortController().signal,
    });
    const track = new FakeTrack('first');
    track.stream.close.mockRejectedValueOnce(new Error('close failed'));
    room.emitSubscribed(track);
    room.emitUnsubscribed(track);
    await expect(transport.closed).resolves.toMatchObject({ type: 'failed' });
    expect(room.publisher.close).toHaveBeenCalledOnce();
    expect(room.disconnect).toHaveBeenCalledOnce();
  });

  it('validates outgoing PCM before capture', async () => {
    const { connector, room } = setup();
    const transport = await connector.connect(descriptor, {
      signal: new AbortController().signal,
    });
    await expect(
      transport.audioOutput.write(mediaFrame({ sampleRateHz: 16_000 })),
    ).rejects.toThrow('LiveKit requires 48000 Hz audio');
    await expect(
      transport.audioOutput.write(mediaFrame({ data: new Uint8Array([1]) })),
    ).rejects.toThrow('non-empty, even PCM byte length');
    expect(room.publisher.capture).not.toHaveBeenCalled();
    await transport.close();
  });

  it('fails and cleans up exactly once on room disconnection', async () => {
    const { connector, room } = setup();
    const transport = await connector.connect(descriptor, {
      signal: new AbortController().signal,
    });
    room.emitDisconnected('server-shutdown');
    room.emitDisconnected('duplicate');
    await expect(transport.closed).resolves.toMatchObject({ type: 'failed' });
    await transport.close();
    expect(room.publisher.close).toHaveBeenCalledOnce();
    expect(room.disconnect).toHaveBeenCalledOnce();
  });

  it('aborts an in-flight connection and disconnects a late completion', async () => {
    const room = new FakeRoom();
    let resolveConnect!: () => void;
    room.connect = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveConnect = resolve;
        }),
    );
    const { connector } = setup(room);
    const abort = new AbortController();
    const connecting = connector.connect(descriptor, { signal: abort.signal });
    await vi.waitFor(() => expect(room.connect).toHaveBeenCalledOnce());
    abort.abort(new Error('cancelled'));
    await expect(connecting).rejects.toThrow('cancelled');
    resolveConnect();
    await vi.waitFor(() => expect(room.disconnect).toHaveBeenCalled());
    expect(room.publishAudio).not.toHaveBeenCalled();
  });

  it('closes active transports and disposes the SDK once', async () => {
    const { connector, room, sdk } = setup();
    const transport = await connector.connect(descriptor, {
      signal: new AbortController().signal,
    });
    await Promise.all([connector.close(), connector.close()]);
    await expect(transport.closed).resolves.toEqual({
      type: 'closed',
      reason: 'local-close',
    });
    expect(room.disconnect).toHaveBeenCalledOnce();
    expect(sdk.dispose).toHaveBeenCalledOnce();
    await expect(
      connector.connect(descriptor, { signal: new AbortController().signal }),
    ).rejects.toThrow('LiveKit connector is closed');
  });
});
