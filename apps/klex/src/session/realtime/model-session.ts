import type {
  AudioFrame,
  AudioSourceMetadata,
  RealtimeEndpoint,
  RealtimeSink,
  RealtimeSourceConsumer,
} from '@/media-transport';
import type {
  InteractionToolRequest,
  InteractionToolResult,
  InteractionUpdateEnvelope,
  PreparedInferenceContext,
} from '@/session/interaction';

export type RealtimeModelEvent =
  | {
      readonly type: 'user-transcript' | 'assistant-transcript';
      readonly eventId: string;
      readonly text: string;
      readonly interrupted?: boolean;
    }
  | {
      readonly type: 'tool-call';
      readonly eventId: string;
      readonly request: InteractionToolRequest;
    }
  | {
      readonly type: 'invalid-tool-call';
      readonly eventId: string;
      readonly result: InteractionToolResult;
    }
  | {
      readonly type: 'approximate-transcript-group';
      readonly eventId: string;
      readonly speaker: 'user' | 'assistant';
      readonly text: string;
      readonly startMs: number;
      readonly endMs: number;
    };

/** One encoded still sampled from the focused video source. */
export interface EncodedImageFrame {
  readonly mimeType: 'image/jpeg';
  readonly width: number;
  readonly height: number;
  readonly timestampUs: number;
  /** `high` spends more provider tokens to keep text legible. */
  readonly detail: 'low' | 'high';
  readonly data: Uint8Array;
}

/**
 * Streaming visual input for providers that accept image frames. Writes
 * never wait on the provider; implementations keep only the newest frame.
 */
export interface RealtimeVideoInput extends RealtimeSink<EncodedImageFrame> {
  readonly maxFps: number;
  /** Adds context about what is visible without requesting a response. */
  describe(text: string): Promise<void>;
}

export interface RealtimeModelSession extends RealtimeEndpoint {
  readonly audioInputs: RealtimeSourceConsumer<AudioFrame, AudioSourceMetadata>;
  readonly audioOutput: AsyncIterable<AudioFrame>;
  /** Present only when the configured model accepts image input. */
  readonly videoInput?: RealtimeVideoInput;
  readonly events: AsyncIterable<RealtimeModelEvent>;
  sendUpdate(update: InteractionUpdateEnvelope): Promise<void>;
  sendToolResult(result: InteractionToolResult): Promise<void>;
}

export interface RealtimeModelSessionFactory {
  create(options: {
    namespace: string;
    sessionId: string;
    signal: AbortSignal;
    context?: PreparedInferenceContext;
  }): Promise<RealtimeModelSession>;
}
