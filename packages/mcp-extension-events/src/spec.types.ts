/**
 * Wire types for the Events extension (`io.modelcontextprotocol/events`).
 *
 * Source: SEP-3415 (modelcontextprotocol/modelcontextprotocol PR #3415),
 * snapshot retrieved 2026-11-12. The SEP is not final: error codes
 * `-32023..-32027` are provisional. Keep wire details in this package only.
 *
 * Conventions: `cursor` is optional and nullable everywhere; absent means null.
 * Only the poll and push (stream) delivery modes are modelled here. Webhook
 * delivery is intentionally out of scope for this package version.
 */

export type EventsDeliveryMode = 'poll' | 'push' | 'webhook';

export type JsonSchemaObject = Record<string, unknown>;

export interface EventsServerSettings {
  /** Whether the server sends `notifications/events/list_changed`. */
  listChanged?: boolean;
}

export interface EventsCapabilities {
  extensions?: Record<string, Record<string, unknown>>;
}

/** Subset of the core `server/discover` result that this extension reads. */
export interface ServerDiscoverResult {
  capabilities?: EventsCapabilities;
  [key: string]: unknown;
}

export interface EventDescriptor {
  name: string;
  description?: string;
  /** Non-empty subset of the delivery modes this event type supports. */
  delivery: EventsDeliveryMode[];
  inputSchema?: JsonSchemaObject;
  payloadSchema?: JsonSchemaObject;
  _meta?: Record<string, unknown>;
}

export interface EventsListParams {
  cursor?: string;
}

export interface EventsListResult {
  resultType?: 'complete';
  events: EventDescriptor[];
  nextCursor?: string;
  _meta?: Record<string, unknown>;
}

export interface EventOccurrence {
  /** Stable upstream id; dedup is scoped to a subscription (name + arguments). */
  eventId: string;
  name: string;
  /** ISO 8601 time the event occurred. */
  timestamp: string;
  data: Record<string, unknown>;
  cursor?: string | null;
  _meta?: Record<string, unknown>;
}

export interface EventsPollParams {
  name: string;
  arguments?: Record<string, unknown>;
  cursor?: string | null;
  maxAgeMs?: number;
  maxEvents?: number;
  _meta?: Record<string, unknown>;
}

export interface EventsPollResult {
  resultType?: 'complete';
  events: EventOccurrence[];
  cursor?: string | null;
  truncated?: boolean;
  hasMore?: boolean;
  nextPollMs?: number;
  _meta?: Record<string, unknown>;
}

export interface EventsStreamParams {
  name: string;
  arguments?: Record<string, unknown>;
  cursor?: string | null;
  maxAgeMs?: number;
  /** Suggested heartbeat interval; the server grants the authoritative value. */
  heartbeatMs?: number;
  _meta?: Record<string, unknown>;
}

export interface EventsStreamResult {
  resultType?: 'complete';
  _meta?: Record<string, unknown>;
}

/** Subscription id echoed on every `notifications/events/*` message. */
export interface EventsSubscriptionMeta {
  'io.modelcontextprotocol/subscriptionId'?: string | number;
  [key: string]: unknown;
}

export interface EventsActiveParams {
  cursor?: string | null;
  truncated?: boolean;
  heartbeatMs?: number;
  _meta?: EventsSubscriptionMeta;
}

export interface EventsHeartbeatParams {
  cursor?: string | null;
  _meta?: EventsSubscriptionMeta;
}

export interface EventsErrorData {
  code: number;
  message: string;
  data?: Record<string, unknown>;
}

/** Recoverable per-occurrence failure; the stream stays open. */
export interface EventsErrorParams {
  error: EventsErrorData;
  _meta?: EventsSubscriptionMeta;
}

/** The subscription has ended. Same shape as the error notification. */
export interface EventsTerminatedParams {
  error: EventsErrorData;
  _meta?: EventsSubscriptionMeta;
}

/** `notifications/events/event` params: an occurrence plus the subscription id. */
export interface EventsEventParams {
  eventId: string;
  name: string;
  timestamp: string;
  data: Record<string, unknown>;
  cursor?: string | null;
  _meta?: EventsSubscriptionMeta;
}

/**
 * Field reserved by this extension in the core `subscriptions/listen`
 * notification filter. The SDK (2.0.0-beta.4) does not type it, so callers
 * merge it into the filter as a plain object. A server echoes it in
 * `notifications/subscriptions/acknowledged` only if it honours it.
 */
export interface EventsListChangedFilter {
  eventsListChanged?: boolean;
}

export interface EventsListChangedParams {
  _meta?: Record<string, unknown>;
}
