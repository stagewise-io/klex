/**
 * MCP Realtime Media Extension Schema
 * Extension Identifier: io.stagewise/realtime-media
 *
 * Run `pnpm generate:schemas` after changing this source of truth.
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

/** Common envelope for a negotiated realtime transport. */
export interface RealtimeMediaTransportDescriptor {
  /** Profile selecting the adapter that validates the remaining fields. */
  profile: string;
  [key: string]: unknown;
}

/** Descriptor specialization for the initial LiveKit room transport. */
export interface LiveKitRoomTransportDescriptor {
  profile: 'livekit-room';
  /** LiveKit server URL. */
  url: string;
  /** Short-lived participant token scoped to this session. */
  token: string;
}

/** Parameters shared by all lifecycle operations. */
export interface RealtimeMediaSessionParams {
  sessionId: string;
}

/** Accepts an unexpired offered session. */
export interface AcceptRealtimeMediaSessionRequest extends JSONRPCRequest {
  method: 'io.stagewise/realtime-media/accept';
  params: RealtimeMediaSessionParams;
}

/** Returns the media-plane credentials only after acceptance. */
export type AcceptRealtimeMediaSessionResult = Result & {
  transport: RealtimeMediaTransportDescriptor;
};

/** Rejects an offered session. */
export interface RejectRealtimeMediaSessionRequest extends JSONRPCRequest {
  method: 'io.stagewise/realtime-media/reject';
  params: RealtimeMediaSessionParams;
}

/** Empty idempotent rejection result. */
export type RejectRealtimeMediaSessionResult = Result;

/** Ends an accepted session. */
export interface EndRealtimeMediaSessionRequest extends JSONRPCRequest {
  method: 'io.stagewise/realtime-media/end';
  params: RealtimeMediaSessionParams;
}

/** Empty idempotent end result. */
export type EndRealtimeMediaSessionResult = Result;

/** Parameters announcing an expiring incoming session. */
export type RealtimeMediaSessionOfferedNotificationParams =
  NotificationParams & {
    sessionId: string;
    /** ISO 8601 expiration time after which acceptance must fail. */
    expiresAt: string;
  };

/** Announces an incoming realtime media session. */
export interface RealtimeMediaSessionOfferedNotification
  extends JSONRPCNotification {
  method: 'io.stagewise/realtime-media/session-offered';
  params: RealtimeMediaSessionOfferedNotificationParams;
}

/** Parameters announcing a terminal remote session state. */
export type RealtimeMediaSessionEndedNotificationParams = NotificationParams & {
  sessionId: string;
  reason?: string;
};

/** Announces that a pending or accepted session ended remotely. */
export interface RealtimeMediaSessionEndedNotification
  extends JSONRPCNotification {
  method: 'io.stagewise/realtime-media/session-ended';
  params: RealtimeMediaSessionEndedNotificationParams;
}

export type RealtimeMediaNotification =
  | RealtimeMediaSessionOfferedNotification
  | RealtimeMediaSessionEndedNotification;

/** Empty realtime-media subscriptions/listen filter. */
export type RealtimeMediaSubscription = Record<string, never>;

export interface RealtimeMediaSubscriptionNotifications {
  'io.stagewise/realtime-media'?: RealtimeMediaSubscription;
}

export interface RealtimeMediaSubscriptionAcknowledgedNotifications {
  'io.stagewise/realtime-media'?: RealtimeMediaSubscription;
}

/** Realtime transport profiles and media kinds supported by one peer. */
export interface RealtimeMediaExtensionCapability {
  transports: string[];
  media: ['audio'];
}

export interface RealtimeMediaExtensionCapabilities {
  [extensionId: string]: unknown;
  'io.stagewise/realtime-media'?: RealtimeMediaExtensionCapability;
}

export interface RealtimeMediaCapabilities {
  [key: string]: unknown;
  extensions?: RealtimeMediaExtensionCapabilities;
}

export interface RealtimeMediaClientCapabilitiesMeta {
  [key: string]: unknown;
  'io.modelcontextprotocol/clientCapabilities'?: RealtimeMediaCapabilities;
}

export interface ServerDiscoverRequest extends JSONRPCRequest {
  method: 'server/discover';
  params: { [key: string]: unknown };
}

export type ServerDiscoverResult = Result & {
  capabilities: RealtimeMediaCapabilities;
};

export interface SubscriptionsListenRequest extends JSONRPCRequest {
  method: 'subscriptions/listen';
  params: {
    [key: string]: unknown;
    notifications: RealtimeMediaSubscriptionNotifications & {
      [key: string]: unknown;
    };
  };
}

export type SubscriptionsListenResult = Result;

export interface SubscriptionsAcknowledgedNotification
  extends JSONRPCNotification {
  method: 'notifications/subscriptions/acknowledged';
  params: NotificationParams & {
    notifications: RealtimeMediaSubscriptionAcknowledgedNotifications & {
      [key: string]: unknown;
    };
  };
}

export interface MissingRequiredClientCapabilityData {
  requiredCapabilities: RealtimeMediaCapabilities;
}

export type RealtimeMediaProtocolErrorKind =
  | 'unknown-session'
  | 'expired-offer'
  | 'invalid-state';

export interface RealtimeMediaProtocolErrorData {
  kind: RealtimeMediaProtocolErrorKind;
  sessionId: string;
}
