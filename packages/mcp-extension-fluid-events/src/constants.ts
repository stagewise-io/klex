export const FLUID_EVENTS_EXTENSION_ID = 'io.stagewise.fluid/events';
export const FLUID_EVENTS_GET_METHOD = `${FLUID_EVENTS_EXTENSION_ID}/get`;
export const FLUID_EVENTS_ACK_METHOD = `${FLUID_EVENTS_EXTENSION_ID}/ack`;
export const FLUID_EVENTS_NOTIFICATION_METHOD =
  'io.stagewise.fluid/notifications/event';
export const SERVER_DISCOVER_METHOD = 'server/discover';
export const SUBSCRIPTIONS_LISTEN_METHOD = 'subscriptions/listen';
export const SUBSCRIPTIONS_ACKNOWLEDGED_METHOD =
  'notifications/subscriptions/acknowledged';
export const CLIENT_CAPABILITIES_META_KEY =
  'io.modelcontextprotocol/clientCapabilities';
export const MISSING_REQUIRED_CLIENT_CAPABILITY_CODE = -32003;
