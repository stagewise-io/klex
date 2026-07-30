export const PUSH_NOTIFICATIONS_EXTENSION_ID =
  'io.stagewise/push-notifications';
export const PUSH_NOTIFICATIONS_GET_METHOD = `${PUSH_NOTIFICATIONS_EXTENSION_ID}/get`;
export const PUSH_NOTIFICATIONS_ACK_METHOD = `${PUSH_NOTIFICATIONS_EXTENSION_ID}/ack`;
export const PUSH_NOTIFICATIONS_NOTIFICATION_METHOD =
  'io.stagewise/push-notifications/event';
export const SERVER_DISCOVER_METHOD = 'server/discover';
export const SUBSCRIPTIONS_LISTEN_METHOD = 'subscriptions/listen';
export const SUBSCRIPTIONS_ACKNOWLEDGED_METHOD =
  'notifications/subscriptions/acknowledged';
export const CLIENT_CAPABILITIES_META_KEY =
  'io.modelcontextprotocol/clientCapabilities';
export const MISSING_REQUIRED_CLIENT_CAPABILITY_CODE = -32003;
