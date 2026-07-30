/**
 * MCP Push Notifications Extension Schema
 * Extension Identifier: io.stagewise/push-notifications
 *
 * This file contains the source TypeScript definitions for the extension.
 * Run `pnpm generate:schemas` after changing it.
 */

interface JSONRPCRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

interface JSONRPCNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

interface Result {
  _meta?: Record<string, unknown>;
}

interface NotificationParams {
  _meta?: Record<string, unknown>;
}

/** JSON data accepted in an event payload. */
export type JSONPrimitive = string | number | boolean | null;

/** JSON data accepted in an event payload. */
export type JSONValue =
  | JSONPrimitive
  | JSONValue[]
  | { [key: string]: JSONValue };

/** A durable event produced by an MCP server. */
export interface PushNotification {
  /** Stable, globally unique identifier and deduplication key. */
  eventId: string;

  /** Stable identifier for the environment or channel that produced the event. */
  sourceId: string;

  /** Open event type whose payload contract is owned by the producer. */
  type: string;

  /** ISO 8601 date-time at which the source created the event. */
  createdAt: string;

  /** JSON object defined by the event type. */
  payload: { [key: string]: JSONValue };
}

/** Parameters for retrieving a page of durable events. */
export interface GetEventsParams {
  [key: string]: unknown;

  /** Opaque server-issued position. Omit to start at the earliest retained event. */
  cursor?: string;

  /** Requested maximum page size. Must be a positive integer. */
  limit?: number;
}

/** Retrieves a bounded page from the durable event feed. */
export interface GetEventsRequest extends JSONRPCRequest {
  method: 'io.stagewise/push-notifications/get';
  params: GetEventsParams;
}

/** Result of retrieving a page from the durable event feed. */
export type GetEventsResult = Result & {
  /** Complete events in stable feed order. */
  events: PushNotification[];

  /** Opaque position to use for the next retrieval or subscription. */
  nextCursor: string;

  /** Whether another page is currently available after nextCursor. */
  hasMore: boolean;
};

/** Parameters for acknowledging durable acceptance of events. */
export interface AcknowledgeEventsParams {
  [key: string]: unknown;

  /** Event identifiers already committed to durable client storage. */
  eventIds: string[];
}

/** Acknowledges durable client acceptance of one or more events. */
export interface AcknowledgeEventsRequest extends JSONRPCRequest {
  method: 'io.stagewise/push-notifications/ack';
  params: AcknowledgeEventsParams;
}

/** Empty, idempotent acknowledgement result. */
export type AcknowledgeEventsResult = Result;

/** Parameters sent with a subscribed push notification. */
export type PushNotificationNotificationParams = NotificationParams & {
  /** Complete durable event. */
  event: PushNotification;

  /** Opaque retrieval position at this event. */
  cursor: string;
};

/** Optional low-latency delivery of an event already available through retrieval. */
export interface PushNotificationNotification extends JSONRPCNotification {
  method: 'io.stagewise/push-notifications/event';
  params: PushNotificationNotificationParams;
}

/** Push Notifications addition to a subscriptions/listen notification filter. */
export interface PushNotificationsSubscription {
  /** Opaque cursor after which notifications should begin. */
  afterCursor?: string;
}

/** Extension-owned fields added to subscriptions/listen notifications. */
export interface PushNotificationsSubscriptionNotifications {
  'io.stagewise/push-notifications'?: PushNotificationsSubscription;
}

/** Push Notifications fields returned in notifications/subscriptions/acknowledged. */
export interface PushNotificationsSubscriptionAcknowledgedNotifications {
  'io.stagewise/push-notifications'?: PushNotificationsSubscription;
}

/** Empty capability object indicating support for the extension. */
export type PushNotificationsExtensionCapability = Record<string, never>;

/** Extensible MCP extension capability map. */
export interface ExtensionCapabilities {
  [extensionId: string]: unknown;
  'io.stagewise/push-notifications'?: PushNotificationsExtensionCapability;
}

/** Capability container used by discovery and initialization negotiation. */
export interface PushNotificationsCapabilities {
  [key: string]: unknown;
  extensions?: ExtensionCapabilities;
}

/** Future MCP per-request client capability metadata. */
export interface PushNotificationsClientCapabilitiesMeta {
  [key: string]: unknown;
  'io.modelcontextprotocol/clientCapabilities'?: PushNotificationsCapabilities;
}

/** Future MCP server discovery request. */
export interface ServerDiscoverRequest extends JSONRPCRequest {
  method: 'server/discover';
  params: {
    [key: string]: unknown;
  };
}

/** Future MCP server discovery result. */
export type ServerDiscoverResult = Result & {
  capabilities: PushNotificationsCapabilities;
};

/** Future MCP notification subscription request. */
export interface SubscriptionsListenRequest extends JSONRPCRequest {
  method: 'subscriptions/listen';
  params: {
    [key: string]: unknown;
    notifications: PushNotificationsSubscriptionNotifications & {
      [key: string]: unknown;
    };
  };
}

/** Empty acknowledgement for a subscription request. */
export type SubscriptionsListenResult = Result;

/** Notification confirming accepted subscription filters. */
export interface SubscriptionsAcknowledgedNotification
  extends JSONRPCNotification {
  method: 'notifications/subscriptions/acknowledged';
  params: NotificationParams & {
    notifications: PushNotificationsSubscriptionAcknowledgedNotifications & {
      [key: string]: unknown;
    };
  };
}

/** JSON-RPC error data for a missing client capability. */
export interface MissingRequiredClientCapabilityData {
  requiredCapabilities: PushNotificationsCapabilities;
}
