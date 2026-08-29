import type { Client } from '@modelcontextprotocol/client';
import { z } from 'zod';

export type SubscriptionAcknowledgementClient = Pick<
  Client,
  'setNotificationHandler'
>;

type SubscriptionAcknowledgementParams = {
  notifications: Record<string, unknown>;
};

type SubscriptionAcknowledgementHandler = (
  params: SubscriptionAcknowledgementParams,
) => void | Promise<void>;

type SubscriptionAcknowledgementDispatcher = Map<
  string,
  SubscriptionAcknowledgementHandler
>;

const subscriptionAcknowledgementParamsSchema = z.object({
  notifications: z.record(z.string(), z.unknown()),
});

const dispatchers = new WeakMap<
  SubscriptionAcknowledgementClient,
  SubscriptionAcknowledgementDispatcher
>();

export function registerSubscriptionAcknowledgementHandler(
  client: SubscriptionAcknowledgementClient,
  extensionId: string,
  handler: SubscriptionAcknowledgementHandler,
): void {
  let dispatcher = dispatchers.get(client);
  if (!dispatcher) {
    dispatcher = new Map();
    dispatchers.set(client, dispatcher);
    client.setNotificationHandler(
      'notifications/subscriptions/acknowledged',
      { params: subscriptionAcknowledgementParamsSchema },
      async (params) => {
        const activeDispatcher = dispatchers.get(client);
        if (!activeDispatcher) return;
        await Promise.all(
          Object.keys(params.notifications).map(
            async (acknowledgedExtensionId) => {
              await activeDispatcher.get(acknowledgedExtensionId)?.(params);
            },
          ),
        );
      },
    );
  }
  dispatcher.set(extensionId, handler);
}
