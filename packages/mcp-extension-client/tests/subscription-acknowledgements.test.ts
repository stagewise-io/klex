import { describe, expect, it, vi } from 'vitest';

import {
  registerSubscriptionAcknowledgementHandler,
  type SubscriptionAcknowledgementClient,
} from '../src/index.js';

function fakeClient() {
  let acknowledgementHandler:
    | ((params: { notifications: Record<string, unknown> }) => Promise<void>)
    | undefined;
  const setNotificationHandler = vi.fn((_method, _schema, handler) => {
    acknowledgementHandler = handler;
  });
  const client = {
    setNotificationHandler,
  } as unknown as SubscriptionAcknowledgementClient;
  return {
    client,
    setNotificationHandler,
    acknowledge: async (notifications: Record<string, unknown>) => {
      await acknowledgementHandler?.({ notifications });
    },
  };
}

describe('subscription acknowledgement dispatcher', () => {
  it('dispatches acknowledgements for multiple extensions through one MCP handler', async () => {
    const { acknowledge, client, setNotificationHandler } = fakeClient();
    const pushHandler = vi.fn();
    const realtimeHandler = vi.fn();

    registerSubscriptionAcknowledgementHandler(
      client,
      'io.stagewise/push-notifications',
      pushHandler,
    );
    registerSubscriptionAcknowledgementHandler(
      client,
      'io.stagewise/realtime-media',
      realtimeHandler,
    );

    expect(setNotificationHandler).toHaveBeenCalledTimes(1);

    await acknowledge({
      'io.stagewise/push-notifications': {},
      'io.stagewise/realtime-media': {},
    });
    expect(pushHandler).toHaveBeenCalledOnce();
    expect(realtimeHandler).toHaveBeenCalledOnce();

    await acknowledge({ 'io.stagewise/unrelated-extension': {} });
    expect(pushHandler).toHaveBeenCalledOnce();
    expect(realtimeHandler).toHaveBeenCalledOnce();
  });
});
