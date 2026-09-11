import type {
  AudioFrame,
  AudioSourceMetadata,
  RealtimeEndpoint,
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
    };

export interface RealtimeModelSession extends RealtimeEndpoint {
  readonly audioInputs: RealtimeSourceConsumer<AudioFrame, AudioSourceMetadata>;
  readonly audioOutput: AsyncIterable<AudioFrame>;
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
