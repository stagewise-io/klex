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
 * Accepts ownership of consuming a source. Attachment resolves after the
 * source is registered, not after its readable terminates.
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
 * A connected external media plane. `audioSources` discovers current and
 * future inputs until transport closure; source IDs are unique while active.
 */
export interface MediaTransport extends RealtimeEndpoint {
  readonly audioSources: AsyncIterable<AudioSource>;
  readonly audioOutput: AudioSink;
}

/** Connects an accepted MCP descriptor to a media plane. */
export interface MediaTransportConnector<Descriptor = unknown> {
  connect(
    descriptor: Descriptor,
    options: { signal: AbortSignal },
  ): Promise<MediaTransport>;
  close(): Promise<void>;
}

/** A connected realtime processor with attributed inputs and one output. */
export interface RealtimeProcessor extends RealtimeEndpoint {
  readonly audioInputs: RealtimeSourceConsumer<AudioFrame, AudioSourceMetadata>;
  readonly audioOutput: AsyncIterable<AudioFrame>;
}

export interface RealtimeProcessorFactory {
  create(options: {
    namespace: string;
    sessionId: string;
    signal: AbortSignal;
  }): Promise<RealtimeProcessor>;
}

/** Copies a frame at an ownership boundary. */
export function cloneAudioFrame(frame: AudioFrame): AudioFrame {
  return { ...frame, data: frame.data.slice() };
}
