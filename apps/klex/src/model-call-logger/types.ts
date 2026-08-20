/**
 * A single model call record — persisted to SQLite and queryable via the
 * admin API. Created by `KlexTelemetry` at the end of every model call
 * (success, abort, or error) and forwarded to `ModelCallLogger.recordCall`.
 */
export interface ModelCallRecord {
  /** Unique record ID (callId from the AI SDK telemetry). */
  id: string;
  /** Session UUID — derived from runtimeContext['conversation.id']. In klex, a conversation is a session. */
  sessionId: string | null;
  /** Provider ID extracted from the klex modelId (providerId:...). */
  providerId: string;
  /** Endpoint ID extracted from the klex modelId (providerId:endpointId:modelId). */
  endpointId: string | null;
  /** Model ID (the final segment of the klex modelId). */
  modelId: string;
  /** Source of the call: chat-session generation or extension-initiated. */
  source: ModelCallSource;
  /** Extension identifier, when source is 'extension'. */
  extensionId: string | null;
  /** Input (prompt) tokens. */
  inputTokens: number;
  /** Output (completion) tokens. */
  outputTokens: number;
  /** Cache-write input tokens (prompt caching). */
  inputCacheWriteTokens: number;
  /** Cache-read input tokens (prompt caching). */
  inputCacheReadTokens: number;
  /** Time to first token in milliseconds, if available. */
  ttftMs: number | null;
  /** Total generation duration in milliseconds, if available. */
  totalDurationMs: number | null;
  /** AI SDK finish reason (stop, tool-calls, error, aborted, etc.). */
  finishReason: string;
  /** Whether the call resulted in an error. */
  isError: boolean;
  /** Error type/name, if the call errored. */
  errorType: string | null;
  /** ISO timestamp when the call started. */
  startedAt: string;
  /** ISO timestamp when the call finished. */
  finishedAt: string;
}

/** Where the model call originated. */
export type ModelCallSource = 'chat' | 'extension';

/** Dimension to split usage data by. */
export type UsageSplitBy = 'none' | 'model' | 'provider' | 'endpoint';

/** Time granularity for usage aggregation. */
export type UsageGranularity = 'event' | 'hourly' | 'daily' | 'weekly';

/** Query parameters for the usage endpoint. */
export interface UsageQuery {
  splitBy: UsageSplitBy;
  /** ISO datetime — inclusive lower bound. */
  from: string | null;
  /** ISO datetime — exclusive upper bound. */
  to: string | null;
  granularity: UsageGranularity;
  /** Maximum number of records to return (event granularity only). */
  limit: number;
}

/** A single aggregated or per-event data point in a usage response. */
export interface UsageDataPoint {
  /** Time bucket (ISO string). Null for event granularity. */
  bucket: string | null;
  /** Split key value (model ID, provider ID, endpoint ID). Null for splitBy=none. */
  splitKey: string | null;
  /** Number of model calls in this bucket/split. */
  callCount: number;
  /** Total input tokens. */
  inputTokens: number;
  /** Total output tokens. */
  outputTokens: number;
  /** Total cache-write input tokens. */
  inputCacheWriteTokens: number;
  /** Total cache-read input tokens. */
  inputCacheReadTokens: number;
  /** Average TTFT in milliseconds (actual for event granularity). */
  ttftMs: number | null;
  /** Average total duration in milliseconds (actual for event granularity). */
  totalDurationMs: number | null;
  /** Number of calls that resulted in an error. */
  errorCount: number;

  // --- Event-level fields (populated only for granularity='event') ---

  /** Record ID. Null for aggregated granularities. */
  id: string | null;
  /** Session UUID. Null for aggregated granularities. */
  sessionId: string | null;
  /** Provider ID. Null for aggregated granularities. */
  providerId: string | null;
  /** Endpoint ID. Null for aggregated granularities. */
  endpointId: string | null;
  /** Model ID. Null for aggregated granularities. */
  modelId: string | null;
  /** Call source ('chat' or 'extension'). Null for aggregated granularities. */
  source: ModelCallSource | null;
  /** Extension identifier. Null for aggregated granularities or non-extension calls. */
  extensionId: string | null;
  /** Finish reason. Null for aggregated granularities. */
  finishReason: string | null;
  /** Error type. Null for aggregated granularities or non-error calls. */
  errorType: string | null;
  /** ISO timestamp when the call started. Null for aggregated granularities. */
  startedAt: string | null;
  /** ISO timestamp when the call finished. Null for aggregated granularities. */
  finishedAt: string | null;
}
