/** A headless PCM audio frame. Payload ownership transfers to the receiver. */
export interface AudioFrame {
  readonly encoding: 'pcm-s16le';
  readonly sampleRateHz: number;
  readonly channels: number;
  readonly sequence: number;
  readonly timestampUs: number;
  readonly data: Uint8Array;
}

export type RealtimeEndpointClosure =
  | { type: 'closed'; reason?: string }
  | { type: 'failed'; error: unknown };

/** A connected realtime endpoint with idempotent teardown. */
export interface RealtimeEndpoint {
  readonly closed: Promise<RealtimeEndpointClosure>;
  close(): Promise<void>;
}

/**
 * One immutable, attributed input discovered during an endpoint's lifetime.
 * The readable has one consumer and terminates consistently with `closed`.
 */
export interface RealtimeSource<T, Metadata> {
  readonly id: string;
  readonly metadata: Metadata;
  readonly readable: AsyncIterable<T>;
  readonly closed: Promise<RealtimeEndpointClosure>;
}

/** An ordered, backpressured output owned by its containing endpoint. */
export interface RealtimeSink<T> {
  write(item: T): Promise<void>;
}

/**
 * Accepts ownership of consuming sources. Attachment resolves after a source
 * is registered, not after its readable terminates. Consumers must support
 * distinct sources concurrently and adapt them to downstream limits. They may
 * reject duplicate active IDs or invalid source data.
 */
export interface RealtimeSourceConsumer<T, Metadata> {
  attach(source: RealtimeSource<T, Metadata>): Promise<void>;
}

export interface AudioSourceMetadata {
  readonly participantId: string;
  readonly trackId: string;
}

export type AudioSource = RealtimeSource<AudioFrame, AudioSourceMetadata>;
export type AudioSink = RealtimeSink<AudioFrame>;

/**
 * A decoded, unrotated RGBA video frame. `rotation` is the clockwise rotation
 * a viewer must apply to display it upright.
 */
export interface RawVideoFrame {
  readonly encoding: 'rgba';
  readonly width: number;
  readonly height: number;
  readonly rotation: 0 | 90 | 180 | 270;
  readonly sequence: number;
  readonly timestampUs: number;
  readonly data: Uint8Array;
}

export type VideoSourceKind = 'camera' | 'screenshare';

export interface VideoSourceMetadata {
  readonly participantId: string;
  readonly displayName?: string;
  readonly trackId: string;
  readonly kind: VideoSourceKind;
}

/** An opened video source. Closing it stops receiving and decoding. */
export interface VideoSource
  extends RealtimeSource<RawVideoFrame, VideoSourceMetadata> {
  close(): Promise<void>;
}

/**
 * A discovered video track that costs nothing until opened. At most one
 * source is open per descriptor; reopening after close is allowed.
 * `closed` settles when the track goes away, which also ends any open source.
 */
export interface VideoSourceDescriptor {
  readonly id: string;
  readonly metadata: VideoSourceMetadata;
  readonly closed: Promise<RealtimeEndpointClosure>;
  /** Delivers at most `maxFps` frames per second, dropping stale frames. */
  open(options: { maxFps: number }): VideoSource;
}

/**
 * A connected external media plane. `audioSources` discovers current and
 * future inputs until transport closure; source IDs are unique while active.
 * `videoSources`, when present, discovers video tracks the same way.
 */
export interface MediaTransport extends RealtimeEndpoint {
  readonly audioSources: AsyncIterable<AudioSource>;
  readonly audioOutput: AudioSink;
  readonly videoSources?: AsyncIterable<VideoSourceDescriptor>;
}

/** Connects an accepted MCP descriptor to a media plane. */
export interface MediaTransportConnector<Descriptor = unknown> {
  connect(
    descriptor: Descriptor,
    options: { signal: AbortSignal },
  ): Promise<MediaTransport>;
  close(): Promise<void>;
}

/** Copies a frame at an ownership boundary. */
export function cloneAudioFrame(frame: AudioFrame): AudioFrame {
  return { ...frame, data: frame.data.slice() };
}
