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
  type LiveKitSdkRemoteVideoPublication,
  type LiveKitSdkRoom,
  type LiveKitSdkVideoFrame,
  type LiveKitSdkVideoStream,
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

  it('keeps only the freshest inbound frames before a consumer attaches', async () => {
    const { connector, room } = setup();
    const transport = await connector.connect(descriptor, {
      signal: new AbortController().signal,
    });
    const track = new FakeTrack('delayed');
    room.emitSubscribed(track);
    const source = await nextSource(transport);

    for (let value = 0; value < 15; value += 1)
      await track.stream.push(rtcFrame(value));
    await vi.waitFor(() => expect(track.stream.yielded).toBe(15));

    const received: AudioFrame[] = [];
    for (let index = 0; index < 10; index += 1)
      received.push(await nextFrame(source));
    expect(received.map((frame) => frame.sequence)).toEqual([
      5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
    ]);
    expect(
      received.map((frame) => new Int16Array(frame.data.buffer)[0]),
    ).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);

    await transport.close();
  });

  it('backpressures inbound frames after a consumer attaches', async () => {
    const { connector, room } = setup();
    const transport = await connector.connect(descriptor, {
      signal: new AbortController().signal,
    });
    const track = new FakeTrack('active');
    room.emitSubscribed(track);
    const source = await nextSource(transport);
    const iterator = source.readable[Symbol.asyncIterator]();

    for (let value = 0; value < 15; value += 1)
      await track.stream.push(rtcFrame(value));
    await vi.waitFor(() => expect(track.stream.yielded).toBe(11));

    const received: AudioFrame[] = [];
    for (let index = 0; index < 15; index += 1) {
      const result = await iterator.next();
      if (result.done) throw new Error('Expected an audio frame');
      received.push(result.value);
    }
    expect(received.map((frame) => frame.sequence)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
    ]);

    await transport.close();
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

class FakeVideoStream implements LiveKitSdkVideoStream {
  readonly queue = new BoundedAsyncQueue<LiveKitSdkVideoFrame>(8);
  close = vi.fn(async () => this.queue.close());
  [Symbol.asyncIterator]() {
    return this.queue[Symbol.asyncIterator]();
  }
}

class FakeVideoPublication implements LiveKitSdkRemoteVideoPublication {
  readonly participantId = 'presenter';
  readonly participantName = 'Dana';
  readonly kind = 'screenshare' as const;
  readonly streams: FakeVideoStream[] = [];
  openStream = vi.fn(() => {
    const stream = new FakeVideoStream();
    this.streams.push(stream);
    return stream;
  });
  constructor(readonly id: string) {}
}

class FakeVideoRoom extends FakeRoom {
  readonly published = new Set<
    (publication: LiveKitSdkRemoteVideoPublication) => void
  >();
  readonly unpublished = new Set<
    (publication: LiveKitSdkRemoteVideoPublication) => void
  >();
  onVideoTrackPublished(
    listener: (publication: LiveKitSdkRemoteVideoPublication) => void,
  ) {
    this.published.add(listener);
    return () => this.published.delete(listener);
  }
  onVideoTrackUnpublished(
    listener: (publication: LiveKitSdkRemoteVideoPublication) => void,
  ) {
    this.unpublished.add(listener);
    return () => this.unpublished.delete(listener);
  }
  publish(publication: LiveKitSdkRemoteVideoPublication): void {
    for (const listener of this.published) listener(publication);
  }
  unpublish(publication: LiveKitSdkRemoteVideoPublication): void {
    for (const listener of this.unpublished) listener(publication);
  }
}

describe('LiveKit video discovery', () => {
  async function connectVideo() {
    const room = new FakeVideoRoom();
    const { connector } = setup(room);
    const transport = await connector.connect(descriptor, {
      signal: new AbortController().signal,
    });
    const videoSources = transport.videoSources;
    if (!videoSources) throw new Error('Expected video discovery');
    return {
      room,
      connector,
      transport,
      discovery: videoSources[Symbol.asyncIterator](),
    };
  }

  it('omits video discovery when the room cannot report video', async () => {
    const { connector } = setup();
    const transport = await connector.connect(descriptor, {
      signal: new AbortController().signal,
    });
    expect(transport.videoSources).toBeUndefined();
    await connector.close();
  });

  it('describes publications without subscribing until opened', async () => {
    const { room, connector, discovery } = await connectVideo();
    const publication = new FakeVideoPublication('screen-1');
    room.publish(publication);
    const next = await discovery.next();
    if (next.done) throw new Error('Expected a descriptor');
    const video = next.value;
    expect(video.metadata).toEqual({
      participantId: 'presenter',
      displayName: 'Dana',
      trackId: 'screen-1',
      kind: 'screenshare',
    });
    expect(publication.openStream).not.toHaveBeenCalled();

    expect(() => video.open({ maxFps: 0 })).toThrow('maxFps');
    const source = video.open({ maxFps: 2 });
    expect(publication.openStream).toHaveBeenCalledWith({ maxFps: 2 });
    expect(() => video.open({ maxFps: 2 })).toThrow('already open');
    await publication.streams[0]?.queue.push({
      data: new Uint8Array(16),
      width: 2,
      height: 2,
      rotation: 90,
    });
    const frame = await source.readable[Symbol.asyncIterator]().next();
    expect(frame.value).toMatchObject({
      encoding: 'rgba',
      width: 2,
      height: 2,
      rotation: 90,
      sequence: 0,
    });
    await source.close();
    expect(publication.streams[0]?.close).toHaveBeenCalled();
    video.open({ maxFps: 2 });
    expect(publication.streams).toHaveLength(2);
    await connector.close();
  });

  it('ends descriptors and open sources when a track is unpublished', async () => {
    const { room, connector, discovery } = await connectVideo();
    const publication = new FakeVideoPublication('screen-1');
    room.publish(publication);
    const next = await discovery.next();
    if (next.done) throw new Error('Expected a descriptor');
    const source = next.value.open({ maxFps: 1 });
    room.unpublish(publication);
    await expect(next.value.closed).resolves.toEqual({
      type: 'closed',
      reason: 'track-unpublished',
    });
    expect(publication.streams[0]?.close).toHaveBeenCalled();
    await expect(source.closed).resolves.toMatchObject({ type: 'closed' });
    expect(() => next.value.open({ maxFps: 1 })).toThrow('unpublished');
    await connector.close();
  });

  it('ends discovery and descriptors when the transport closes', async () => {
    const { room, connector, transport, discovery } = await connectVideo();
    const publication = new FakeVideoPublication('screen-1');
    room.publish(publication);
    const next = await discovery.next();
    if (next.done) throw new Error('Expected a descriptor');
    await transport.close();
    await expect(next.value.closed).resolves.toMatchObject({ type: 'closed' });
    await expect(discovery.next()).resolves.toMatchObject({ done: true });
    await connector.close();
  });
});
