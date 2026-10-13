import assert from 'node:assert/strict';

import { registerPushNotificationsClient } from '@stagewise/mcp-extension-push-notifications/client';
import { registerRealtimeMediaClient } from '@stagewise/mcp-extension-realtime-media/client';

const acknowledgementMethod = 'notifications/subscriptions/acknowledged';
// Exercise installed client helpers together, rather than importing the shared helper directly.
for (const realtimeFirst of [false, true]) {
  const handlers = new Map();
  let acknowledgementRegistrations = 0;
  const client = {
    registerCapabilities() {},
    getProtocolEra() {
      return undefined;
    },
    getServerCapabilities() {
      return undefined;
    },
    request() {
      throw new Error('Acknowledged support must not require discovery');
    },
    setNotificationHandler(method, _schema, handler) {
      if (method === acknowledgementMethod) acknowledgementRegistrations++;
      handlers.set(method, handler);
    },
  };
  let push;
  let realtime;
  if (realtimeFirst) {
    realtime = registerRealtimeMediaClient(client);
    push = registerPushNotificationsClient(client);
  } else {
    push = registerPushNotificationsClient(client);
    realtime = registerRealtimeMediaClient(client);
  }
  assert.equal(
    acknowledgementRegistrations,
    1,
    'Both extensions must share one helper module',
  );
  const subscription = {};
  await handlers.get(acknowledgementMethod)({
    notifications: {
      'io.stagewise/push-notifications': subscription,
      'io.stagewise/realtime-media': subscription,
    },
  });
  assert.deepEqual(push.acknowledgedSubscription(), subscription);
  assert.equal(await push.serverSupportsPushNotifications(), true);
  assert.equal(await realtime.serverSupportsRealtimeMedia(), true);
}
