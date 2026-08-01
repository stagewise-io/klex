/** A headless PCM audio frame. Payload ownership transfers to the receiver. */
export interface AudioFrame {
  readonly encoding: 'pcm-s16le';
  readonly sampleRateHz: number;
  readonly channels: number;
  readonly sequence: number;
  readonly timestampUs: number;
  readonly data: Uint8Array;
}

export type MediaTransportClosure =
  | { type: 'closed'; reason?: string }
  | { type: 'failed'; error: unknown };

/**
 * A connected media plane. Implementations must bound their internal buffers.
 * Awaiting send applies outbound backpressure. close is idempotent.
 */
export interface MediaTransport {
  readonly incoming: AsyncIterable<AudioFrame>;
  readonly closed: Promise<MediaTransportClosure>;
  send(frame: AudioFrame): Promise<void>;
  close(): Promise<void>;
}

/** Connects an accepted MCP descriptor to a media plane. */
export interface MediaTransportConnector {
  connect(
    descriptor: unknown,
    options: { signal: AbortSignal },
  ): Promise<MediaTransport>;
}

export type RealtimeAudioProcessorClosure =
  | { type: 'closed'; reason?: string }
  | { type: 'failed'; error: unknown };

/**
 * A duplex audio processor. writeInput and output consumption both provide
 * backpressure. Implementations must make close idempotent.
 */
export interface RealtimeAudioProcessor {
  readonly output: AsyncIterable<AudioFrame>;
  readonly closed: Promise<RealtimeAudioProcessorClosure>;
  writeInput(frame: AudioFrame): Promise<void>;
  close(): Promise<void>;
}

export interface RealtimeAudioProcessorFactory {
  create(options: {
    namespace: string;
    sessionId: string;
    signal: AbortSignal;
  }): Promise<RealtimeAudioProcessor>;
}

/** Copies a frame at an ownership boundary. */
export function cloneAudioFrame(frame: AudioFrame): AudioFrame {
  return { ...frame, data: frame.data.slice() };
}
