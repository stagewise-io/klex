export const REALTIME_MEDIA_EXTENSION_ID = 'io.stagewise/realtime-media';
export const REALTIME_MEDIA_ACCEPT_METHOD = `${REALTIME_MEDIA_EXTENSION_ID}/accept`;
export const REALTIME_MEDIA_REJECT_METHOD = `${REALTIME_MEDIA_EXTENSION_ID}/reject`;
export const REALTIME_MEDIA_END_METHOD = `${REALTIME_MEDIA_EXTENSION_ID}/end`;
export const REALTIME_MEDIA_SESSION_OFFERED_METHOD = `${REALTIME_MEDIA_EXTENSION_ID}/session-offered`;
export const REALTIME_MEDIA_SESSION_ENDED_METHOD = `${REALTIME_MEDIA_EXTENSION_ID}/session-ended`;
export const SERVER_DISCOVER_METHOD = 'server/discover';
export const SUBSCRIPTIONS_LISTEN_METHOD = 'subscriptions/listen';
export const SUBSCRIPTIONS_ACKNOWLEDGED_METHOD =
  'notifications/subscriptions/acknowledged';
export const CLIENT_CAPABILITIES_META_KEY =
  'io.modelcontextprotocol/clientCapabilities';
export const SUBSCRIPTION_ID_META_KEY =
  'io.modelcontextprotocol/subscriptionId';

export const MISSING_REQUIRED_CLIENT_CAPABILITY_CODE = -32_003;
export const REALTIME_MEDIA_UNKNOWN_SESSION_CODE = -32_020;
export const REALTIME_MEDIA_EXPIRED_OFFER_CODE = -32_021;
export const REALTIME_MEDIA_INVALID_STATE_CODE = -32_022;
