export const EVENTS_EXTENSION_ID = 'io.modelcontextprotocol/events';

export const EVENTS_LIST_METHOD = 'events/list';
export const EVENTS_POLL_METHOD = 'events/poll';
export const EVENTS_STREAM_METHOD = 'events/stream';
export const EVENTS_SUBSCRIBE_METHOD = 'events/subscribe';
export const EVENTS_UNSUBSCRIBE_METHOD = 'events/unsubscribe';

export const EVENTS_ACTIVE_NOTIFICATION = 'notifications/events/active';
export const EVENTS_EVENT_NOTIFICATION = 'notifications/events/event';
export const EVENTS_HEARTBEAT_NOTIFICATION = 'notifications/events/heartbeat';
export const EVENTS_ERROR_NOTIFICATION = 'notifications/events/error';
export const EVENTS_TERMINATED_NOTIFICATION = 'notifications/events/terminated';
export const EVENTS_LIST_CHANGED_NOTIFICATION =
  'notifications/events/list_changed';

export const SERVER_DISCOVER_METHOD = 'server/discover';
export const SUBSCRIPTIONS_LISTEN_METHOD = 'subscriptions/listen';

export const CLIENT_CAPABILITIES_META_KEY =
  'io.modelcontextprotocol/clientCapabilities';
export const SUBSCRIPTION_ID_META_KEY =
  'io.modelcontextprotocol/subscriptionId';

/** Default floor for `nextPollMs` so a misbehaving server cannot cause a tight loop. */
export const DEFAULT_MIN_POLL_INTERVAL_MS = 1000;
/** A stream is dead after this many granted heartbeat intervals of silence. */
export const HEARTBEAT_TIMEOUT_FACTOR = 3;

/**
 * Error codes from the SEP-3415 snapshot. `-32602` is standard JSON-RPC.
 * `-32023..-32027` are PROVISIONAL until the SEP's code allocation is final.
 * `-32601` (method not found) is what servers without the extension return.
 */
export const EVENTS_ERROR_CODES = {
  MethodNotFound: -32601,
  InvalidParams: -32602,
  HeaderMismatch: -32020,
  NotFound: -32023,
  Forbidden: -32024,
  ResourceExhausted: -32025,
  Unsupported: -32026,
  CallbackEndpointError: -32027,
} as const;
