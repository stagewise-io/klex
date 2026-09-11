import type { JSONValue } from '@ai-sdk/provider';
import type { ModelMessage, ToolSet } from 'ai';

import type { ModelInputCapabilities } from '@/config';
import type { SessionInboxEvent } from '@/session/inbox';

export type InteractionMode = 'realtime';

export interface InteractionModelMetadata {
  readonly modelId: string;
  readonly displayName?: string;
  readonly contextSize: number;
  readonly inputCapabilities: ModelInputCapabilities;
}

export interface InteractionToolDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface PreparedInferenceContext {
  readonly instructions: string;
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly InteractionToolDescriptor[];
  readonly model: InteractionModelMetadata;
  readonly historyRevision: number;
  readonly updateWatermark: number;
}

export interface PreparedInferenceContextHandle {
  readonly context: PreparedInferenceContext;
  commit(): void;
  rollback(): void;
}

export interface InteractionUpdateEnvelope {
  readonly sequence: number;
  readonly eventId: string;
  readonly event: SessionInboxEvent;
  readonly requestResponse: boolean;
}

export interface InteractionToolRequest {
  readonly executionId: string;
  readonly name: string;
  readonly input: JSONValue;
}

export type InteractionToolResult =
  | {
      readonly executionId: string;
      readonly status: 'success';
      readonly output: JSONValue;
    }
  | {
      readonly executionId: string;
      readonly status: 'error';
      readonly code:
        | 'tool-not-found'
        | 'tool-not-implemented'
        | 'timeout'
        | 'aborted'
        | 'execution-failed'
        | 'invalid-input'
        | 'invalid-output';
      readonly error: string;
      readonly retryable: boolean;
    };

export type RealtimeCommitEvent =
  | {
      readonly type: 'session-started' | 'session-ended';
      readonly eventId: string;
      readonly timestamp: string;
      readonly reason?: string;
    }
  | {
      readonly type: 'user-transcript' | 'assistant-transcript';
      readonly eventId: string;
      readonly timestamp: string;
      readonly text: string;
      readonly interrupted?: boolean;
    }
  | {
      readonly type: 'tool-call';
      readonly eventId: string;
      readonly timestamp: string;
      readonly request: InteractionToolRequest;
    }
  | {
      readonly type: 'tool-result';
      readonly eventId: string;
      readonly timestamp: string;
      readonly result: InteractionToolResult;
    };

export type InteractionLeaseClosure =
  | { readonly type: 'released'; readonly reason?: string }
  | {
      readonly type: 'revoked';
      readonly reason:
        | 'primary-session-closed'
        | 'primary-session-terminated'
        | 'update-overflow';
    }
  | { readonly type: 'failed'; readonly error: unknown };

export interface InteractionLease {
  readonly id: string;
  readonly sessionId: string;
  readonly mode: InteractionMode;
  readonly closed: Promise<InteractionLeaseClosure>;
  readonly updates: AsyncIterable<InteractionUpdateEnvelope>;
  bootstrap(): Promise<PreparedInferenceContextHandle>;
  acknowledgeUpdate(sequence: number): void;
  executeTool(request: InteractionToolRequest): Promise<InteractionToolResult>;
  commit(event: RealtimeCommitEvent): Promise<void>;
  release(reason?: string, finalEvent?: RealtimeCommitEvent): Promise<void>;
}

export interface InteractionLeaseRequest {
  readonly mode: InteractionMode;
  readonly externalSessionId: string;
  readonly namespace: string;
  readonly signal: AbortSignal;
  readonly model: InteractionModelMetadata;
}

export interface ConversationHost {
  acquireInteractionLease(
    request: InteractionLeaseRequest,
  ): Promise<InteractionLease>;
}

export interface SessionToolRuntime {
  readonly tools: ToolSet;
  execute(request: InteractionToolRequest): Promise<InteractionToolResult>;
}
