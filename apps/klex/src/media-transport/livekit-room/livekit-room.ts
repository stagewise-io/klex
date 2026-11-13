import {
  type LiveKitRoomTransportDescriptor,
  LiveKitRoomTransportDescriptorSchema,
} from '@stagewise/mcp-extension-realtime-media';

import { BoundedAsyncQueue } from '../async-queue';

export { loadLiveKitSdk } from './sdk-loader';

import type {
  AudioFrame,
  AudioSource,
  AudioSourceMetadata,
  MediaTransport,
  MediaTransportConnector,
  RawVideoFrame,
  RealtimeEndpointClosure,
  VideoSource,
  VideoSourceDescriptor,
  VideoSourceKind,
  VideoSourceMetadata,
} from '../media-transport';

const SAMPLE_RATE_HZ = 48_000;
const CHANNELS = 1;
const FRAME_SIZE_MS = 20;
const INCOMING_QUEUE_CAPACITY = 10;
const OUTGOING_QUEUE_MS = 200;
const VIDEO_DESCRIPTOR_QUEUE_CAPACITY = 32;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export interface LiveKitSdkAudioFrame {
  readonly data: Int16Array;
  readonly sampleRate: number;
  readonly channels: number;
  readonly samplesPerChannel: number;
}

export interface LiveKitSdkAudioStream
  extends AsyncIterable<LiveKitSdkAudioFrame> {
  close(): Promise<void>;
}

export interface LiveKitSdkRemoteAudioTrack {
  readonly id: string;
  readonly participantId: string;
  openStream(options: {
    sampleRate: number;
    channels: number;
    frameSizeMs: number;
  }): LiveKitSdkAudioStream;
}

export interface LiveKitSdkAudioPublisher {
  capture(data: Int16Array, samplesPerChannel: number): Promise<void>;
  close(): Promise<void>;
}

/** A decoded RGBA frame; `rotation` is clockwise degrees to display upright. */
export interface LiveKitSdkVideoFrame {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly rotation: 0 | 90 | 180 | 270;
}

export interface LiveKitSdkVideoStream
  extends AsyncIterable<LiveKitSdkVideoFrame> {
  close(): Promise<void>;
}

/** A remote camera or screen-share publication, unsubscribed until opened. */
export interface LiveKitSdkRemoteVideoPublication {
  readonly id: string;
  readonly participantId: string;
  readonly participantName?: string;
  readonly kind: VideoSourceKind;
  /** Subscribes and decodes at most `maxFps` frames per second until closed. */
  openStream(options: { maxFps: number }): LiveKitSdkVideoStream;
}

export interface LiveKitSdkRoom {
  connect(url: string, token: string): Promise<void>;
  publishAudio(options: {
    sampleRate: number;
    channels: number;
    queueSizeMs: number;
  }): Promise<LiveKitSdkAudioPublisher>;
  onAudioTrackSubscribed(
    listener: (track: LiveKitSdkRemoteAudioTrack) => void,
  ): () => void;
  onAudioTrackUnsubscribed(
    listener: (track: LiveKitSdkRemoteAudioTrack) => void,
  ): () => void;
  /** Omitted by audio-only rooms; such transports expose no video sources. */
  onVideoTrackPublished?(
    listener: (publication: LiveKitSdkRemoteVideoPublication) => void,
  ): () => void;
  onVideoTrackUnpublished?(
    listener: (publication: LiveKitSdkRemoteVideoPublication) => void,
  ): () => void;
  onDisconnected(listener: (reason: string) => void): () => void;
  disconnect(): Promise<void>;
}

export interface LiveKitSdk {
  createRoom(): LiveKitSdkRoom;
  dispose(): Promise<void>;
}

export type LiveKitSdkLoader = () => Promise<LiveKitSdk>;

export interface LiveKitRoomMediaTransportConnector
  extends MediaTransportConnector<LiveKitRoomTransportDescriptor> {
  close(): Promise<void>;
}

class LiveKitAudioSourceModule implements AudioSource {
  private readonly queue: BoundedAsyncQueue<AudioFrame>;
  private readonly closure = deferred<RealtimeEndpointClosure>();
  private sequence = 0;
  private settled = false;

  readonly metadata: AudioSourceMetadata;
  readonly readable: AsyncIterable<AudioFrame>;
  readonly closed = this.closure.promise;

  constructor(
    readonly id: string,
    participantId: string,
    private readonly stream: LiveKitSdkAudioStream,
    private readonly onFailure: (error: unknown) => void,
  ) {
    this.metadata = Object.freeze({ participantId, trackId: id });
    this.queue = new BoundedAsyncQueue<AudioFrame>(INCOMING_QUEUE_CAPACITY, {
      overflow: 'drop-oldest',
    });
    this.readable = {
      [Symbol.asyncIterator]: () => {
        this.queue.setOverflow('backpressure');
        return this.queue[Symbol.asyncIterator]();
      },
    };
    void this.pump();
  }

  close(reason?: string): Promise<void> {
    return this.settle({ type: 'closed', reason });
  }

  fail(error: unknown): Promise<void> {
    return this.settle({ type: 'failed', error }, error);
  }

  private async pump(): Promise<void> {
    try {
      for await (const frame of this.stream) {
        const bytes = new Uint8Array(frame.data.byteLength);
        bytes.set(
          new Uint8Array(
            frame.data.buffer,
            frame.data.byteOffset,
            frame.data.byteLength,
          ),
        );
        await this.queue.push({
          encoding: 'pcm-s16le',
          sampleRateHz: frame.sampleRate,
          channels: frame.channels,
          sequence: this.sequence++,
          timestampUs: Number(process.hrtime.bigint() / 1_000n),
          data: bytes,
        });
      }
      await this.close('track-ended');
    } catch (error) {
      if (!this.settled) {
        await this.fail(error);
        this.onFailure(error);
      }
    }
  }

  private async settle(
    closure: RealtimeEndpointClosure,
    error?: unknown,
  ): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    this.queue.close(error);
    try {
      await this.stream.close();
      this.closure.resolve(closure);
    } catch (streamError) {
      const failed = { type: 'failed', error: streamError } as const;
      this.closure.resolve(failed);
      throw streamError;
    }
  }
}

class LiveKitVideoSourceModule implements VideoSource {
  // Video is sampled, not streamed: only the newest frame matters.
  private readonly queue = new BoundedAsyncQueue<RawVideoFrame>(1, {
    overflow: 'drop-oldest',
  });
  private readonly closure = deferred<RealtimeEndpointClosure>();
  private sequence = 0;
  private settled = false;

  readonly readable: AsyncIterable<RawVideoFrame> = this.queue;
  readonly closed = this.closure.promise;

  constructor(
    readonly id: string,
    readonly metadata: VideoSourceMetadata,
    private readonly stream: LiveKitSdkVideoStream,
  ) {
    void this.pump();
  }

  close(reason = 'local-close'): Promise<void> {
    return this.settle({ type: 'closed', reason });
  }

  get active(): boolean {
    return !this.settled;
  }

  private async pump(): Promise<void> {
    try {
      for await (const frame of this.stream) {
        if (this.settled) return;
        await this.queue.push({
          encoding: 'rgba',
          width: frame.width,
          height: frame.height,
          rotation: frame.rotation,
          sequence: this.sequence++,
          timestampUs: Number(process.hrtime.bigint() / 1_000n),
          data: frame.data,
        });
      }
      await this.settle({ type: 'closed', reason: 'track-ended' });
    } catch (error) {
      await this.settle({ type: 'failed', error }, error).catch(
        () => undefined,
      );
    }
  }

  private async settle(
    closure: RealtimeEndpointClosure,
    error?: unknown,
  ): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    this.queue.close(error);
    try {
      await this.stream.close();
      this.closure.resolve(closure);
    } catch (streamError) {
      this.closure.resolve({ type: 'failed', error: streamError });
    }
  }
}

class LiveKitVideoSourceDescriptorModule implements VideoSourceDescriptor {
  private readonly closure = deferred<RealtimeEndpointClosure>();
  private current: LiveKitVideoSourceModule | undefined;
  private ended = false;

  readonly id: string;
  readonly metadata: VideoSourceMetadata;
  readonly closed = this.closure.promise;

  constructor(private readonly publication: LiveKitSdkRemoteVideoPublication) {
    this.id = publication.id;
    this.metadata = Object.freeze({
      participantId: publication.participantId,
      ...(publication.participantName && {
        displayName: publication.participantName,
      }),
      trackId: publication.id,
      kind: publication.kind,
    });
  }

  open(options: { maxFps: number }): VideoSource {
    if (this.ended) throw new Error('LiveKit video track is unpublished');
    if (this.current?.active)
      throw new Error('LiveKit video source is already open');
    if (!(options.maxFps > 0))
      throw new Error('LiveKit video maxFps must be positive');
    this.current = new LiveKitVideoSourceModule(
      this.id,
      this.metadata,
      this.publication.openStream({ maxFps: options.maxFps }),
    );
    return this.current;
  }

  async end(closure: RealtimeEndpointClosure): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    await this.current?.close(
      closure.type === 'closed' ? closure.reason : 'transport-failed',
    );
    this.closure.resolve(closure);
  }
}

class LiveKitRoomMediaTransportModule implements MediaTransport {
  private readonly sourceQueue = new BoundedAsyncQueue<AudioSource>(32);
  // Consumers that ignore video must not stall discovery.
  private readonly videoQueue =
    new BoundedAsyncQueue<LiveKitVideoSourceDescriptorModule>(
      VIDEO_DESCRIPTOR_QUEUE_CAPACITY,
      { overflow: 'drop-oldest' },
    );
  private readonly videoDescriptors = new Map<
    string,
    LiveKitVideoSourceDescriptorModule
  >();
  private readonly closure = deferred<RealtimeEndpointClosure>();
  private readonly unsubscribe: Array<() => void> = [];
  private readonly activeSources = new Map<string, LiveKitAudioSourceModule>();
  private publisher: LiveKitSdkAudioPublisher | undefined;
  private closing = false;
  private closePromise: Promise<void> | undefined;

  readonly audioSources = this.sourceQueue;
  readonly audioOutput = {
    write: (frame: AudioFrame) => this.writeAudio(frame),
  };
  readonly videoSources: AsyncIterable<VideoSourceDescriptor> | undefined;
  readonly closed = this.closure.promise;

  constructor(
    private readonly room: LiveKitSdkRoom,
    private readonly signal: AbortSignal,
    private readonly onSettled: () => void,
  ) {
    this.videoSources = room.onVideoTrackPublished
      ? this.videoQueue
      : undefined;
  }

  async start(url: string, token: string): Promise<void> {
    this.unsubscribe.push(
      this.room.onAudioTrackSubscribed((track) => this.handleTrack(track)),
      this.room.onAudioTrackUnsubscribed((track) =>
        this.handleTrackUnsubscribed(track),
      ),
      ...(this.room.onVideoTrackPublished
        ? [
            this.room.onVideoTrackPublished((publication) =>
              this.handleVideoPublished(publication),
            ),
          ]
        : []),
      ...(this.room.onVideoTrackUnpublished
        ? [
            this.room.onVideoTrackUnpublished((publication) =>
              this.handleVideoUnpublished(publication),
            ),
          ]
        : []),
      this.room.onDisconnected((reason) => {
        if (!this.closing)
          void this.finish(
            {
              type: 'failed',
              error: new Error(`LiveKit room disconnected: ${reason}`),
            },
            new Error(`LiveKit room disconnected: ${reason}`),
          );
      }),
    );
    this.signal.addEventListener('abort', this.handleAbort, { once: true });
    if (this.signal.aborted) throw abortReason(this.signal);

    try {
      const connection = this.room.connect(url, token);
      void connection
        .then(() => (this.closing ? this.room.disconnect() : undefined))
        .catch(() => undefined);
      await raceAbort(connection, this.signal);
      if (this.signal.aborted) throw abortReason(this.signal);
      const publication = this.room.publishAudio({
        sampleRate: SAMPLE_RATE_HZ,
        channels: CHANNELS,
        queueSizeMs: OUTGOING_QUEUE_MS,
      });
      void publication
        .then((publisher) => (this.closing ? publisher.close() : undefined))
        .catch(() => undefined);
      this.publisher = await raceAbort(publication, this.signal);
      if (this.signal.aborted) throw abortReason(this.signal);
    } catch (error) {
      await this.finish({ type: 'failed', error }, error);
      throw error;
    }
  }

  private async writeAudio(frame: AudioFrame): Promise<void> {
    if (this.closing) throw new Error('LiveKit media transport is closed');
    validateFrame(frame);
    const publisher = this.publisher;
    if (!publisher) throw new Error('LiveKit media transport is not connected');
    const bytes = frame.data.slice();
    const aligned = new Int16Array(
      bytes.byteLength / Int16Array.BYTES_PER_ELEMENT,
    );
    new Uint8Array(aligned.buffer).set(bytes);
    await publisher.capture(aligned, aligned.length / CHANNELS);
  }

  close(): Promise<void> {
    return this.finish({ type: 'closed', reason: 'local-close' });
  }

  private readonly handleAbort = (): void => {
    void this.finish({ type: 'closed', reason: 'aborted' });
  };

  private handleTrack(track: LiveKitSdkRemoteAudioTrack): void {
    if (this.closing || this.activeSources.has(track.id)) return;
    const source = new LiveKitAudioSourceModule(
      track.id,
      track.participantId,
      track.openStream({
        sampleRate: SAMPLE_RATE_HZ,
        channels: CHANNELS,
        frameSizeMs: FRAME_SIZE_MS,
      }),
      (error) => {
        if (!this.closing) void this.finish({ type: 'failed', error }, error);
      },
    );
    this.activeSources.set(track.id, source);
    void source.closed.then(() => this.activeSources.delete(track.id));
    void this.sourceQueue.push(source).catch((error: unknown) => {
      if (!this.closing) void this.finish({ type: 'failed', error }, error);
    });
  }

  private handleTrackUnsubscribed(track: LiveKitSdkRemoteAudioTrack): void {
    const source = this.activeSources.get(track.id);
    if (!source) return;
    this.activeSources.delete(track.id);
    void source.close('track-unsubscribed').catch((error: unknown) => {
      if (!this.closing) void this.finish({ type: 'failed', error }, error);
    });
  }

  private handleVideoPublished(
    publication: LiveKitSdkRemoteVideoPublication,
  ): void {
    if (this.closing || this.videoDescriptors.has(publication.id)) return;
    const descriptor = new LiveKitVideoSourceDescriptorModule(publication);
    this.videoDescriptors.set(publication.id, descriptor);
    void this.videoQueue.push(descriptor).catch(() => undefined);
  }

  private handleVideoUnpublished(
    publication: LiveKitSdkRemoteVideoPublication,
  ): void {
    const descriptor = this.videoDescriptors.get(publication.id);
    if (!descriptor) return;
    this.videoDescriptors.delete(publication.id);
    void descriptor.end({ type: 'closed', reason: 'track-unpublished' });
  }

  private finish(
    closure: RealtimeEndpointClosure,
    error?: unknown,
  ): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      this.signal.removeEventListener('abort', this.handleAbort);
      for (const remove of this.unsubscribe.splice(0)) remove();
      this.sourceQueue.close(error);
      this.videoQueue.close();
      const sources = [...this.activeSources.values()];
      this.activeSources.clear();
      const videoDescriptors = [...this.videoDescriptors.values()];
      this.videoDescriptors.clear();
      await Promise.allSettled([
        ...sources.map((source) =>
          closure.type === 'failed'
            ? source.fail(closure.error)
            : source.close(closure.reason),
        ),
        ...videoDescriptors.map((descriptor) => descriptor.end(closure)),
        this.publisher?.close(),
        this.room.disconnect(),
      ]);
      this.publisher = undefined;
      this.onSettled();
      this.closure.resolve(closure);
    })();
    return this.closePromise;
  }
}

class LiveKitRoomMediaTransportConnectorModule
  implements LiveKitRoomMediaTransportConnector
{
  private readonly transports = new Set<LiveKitRoomMediaTransportModule>();
  private sdkPromise: Promise<LiveKitSdk> | undefined;
  private closing = false;
  private closePromise: Promise<void> | undefined;

  constructor(private readonly loadSdk: LiveKitSdkLoader) {}

  async connect(
    descriptor: LiveKitRoomTransportDescriptor,
    options: { signal: AbortSignal },
  ): Promise<MediaTransport> {
    if (this.closing) throw new Error('LiveKit connector is closed');
    const parsed = LiveKitRoomTransportDescriptorSchema.parse(descriptor);
    if (options.signal.aborted) throw abortReason(options.signal);
    const sdk = await this.getSdk();
    if (this.closing) throw new Error('LiveKit connector is closed');
    const room = sdk.createRoom();
    let transport!: LiveKitRoomMediaTransportModule;
    transport = new LiveKitRoomMediaTransportModule(room, options.signal, () =>
      this.transports.delete(transport),
    );
    this.transports.add(transport);
    try {
      await transport.start(parsed.url, parsed.token);
      return transport;
    } catch (error) {
      this.transports.delete(transport);
      throw error;
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      await Promise.allSettled(
        [...this.transports].map((transport) => transport.close()),
      );
      this.transports.clear();
      if (this.sdkPromise) await (await this.sdkPromise).dispose();
    })();
    return this.closePromise;
  }

  private getSdk(): Promise<LiveKitSdk> {
    this.sdkPromise ??= this.loadSdk();
    return this.sdkPromise;
  }
}

export function createLiveKitRoomMediaTransportConnector(options: {
  loadSdk: LiveKitSdkLoader;
}): LiveKitRoomMediaTransportConnector {
  return new LiveKitRoomMediaTransportConnectorModule(options.loadSdk);
}

function validateFrame(frame: AudioFrame): void {
  if (frame.encoding !== 'pcm-s16le')
    throw new Error('LiveKit requires pcm-s16le audio');
  if (frame.sampleRateHz !== SAMPLE_RATE_HZ)
    throw new Error(`LiveKit requires ${SAMPLE_RATE_HZ} Hz audio`);
  if (frame.channels !== CHANNELS)
    throw new Error(`LiveKit requires ${CHANNELS} audio channel`);
  if (frame.data.byteLength === 0 || frame.data.byteLength % 2 !== 0)
    throw new Error('LiveKit requires a non-empty, even PCM byte length');
  const sampleCount = frame.data.byteLength / 2;
  if (!Number.isInteger(sampleCount / frame.channels))
    throw new Error('LiveKit PCM sample count must divide evenly by channels');
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Operation aborted', 'AbortError');
}

function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
