import { LiveKitRoomTransportDescriptorSchema } from '@stagewise/mcp-extension-realtime-media';

import { BoundedAsyncQueue } from '../async-queue';

export { loadLiveKitSdk } from './sdk-loader';

import type {
  AudioFrame,
  AudioSource,
  AudioSourceMetadata,
  MediaTransport,
  MediaTransportConnector,
  RealtimeEndpointClosure,
} from '../media-transport';

const SAMPLE_RATE_HZ = 48_000;
const CHANNELS = 1;
const FRAME_SIZE_MS = 20;
const INCOMING_QUEUE_CAPACITY = 10;
const OUTGOING_QUEUE_MS = 200;

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
  onDisconnected(listener: (reason: string) => void): () => void;
  disconnect(): Promise<void>;
}

export interface LiveKitSdk {
  createRoom(): LiveKitSdkRoom;
  dispose(): Promise<void>;
}

export type LiveKitSdkLoader = () => Promise<LiveKitSdk>;

export interface LiveKitRoomMediaTransportConnector
  extends MediaTransportConnector {
  close(): Promise<void>;
}

class LiveKitAudioSourceModule implements AudioSource {
  private readonly queue = new BoundedAsyncQueue<AudioFrame>(
    INCOMING_QUEUE_CAPACITY,
  );
  private readonly closure = deferred<RealtimeEndpointClosure>();
  private sequence = 0;
  private settled = false;

  readonly metadata: AudioSourceMetadata;
  readonly readable = this.queue;
  readonly closed = this.closure.promise;

  constructor(
    readonly id: string,
    participantId: string,
    private readonly stream: LiveKitSdkAudioStream,
    private readonly onFailure: (error: unknown) => void,
  ) {
    this.metadata = Object.freeze({ participantId, trackId: id });
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

class LiveKitRoomMediaTransportModule implements MediaTransport {
  private readonly sourceQueue = new BoundedAsyncQueue<AudioSource>(32);
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
  readonly closed = this.closure.promise;

  constructor(
    private readonly room: LiveKitSdkRoom,
    private readonly signal: AbortSignal,
    private readonly onSettled: () => void,
  ) {}

  async start(url: string, token: string): Promise<void> {
    this.unsubscribe.push(
      this.room.onAudioTrackSubscribed((track) => this.handleTrack(track)),
      this.room.onAudioTrackUnsubscribed((track) =>
        this.handleTrackUnsubscribed(track),
      ),
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
      const sources = [...this.activeSources.values()];
      this.activeSources.clear();
      await Promise.allSettled([
        ...sources.map((source) =>
          closure.type === 'failed'
            ? source.fail(closure.error)
            : source.close(closure.reason),
        ),
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
    descriptor: unknown,
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
