import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';

import type { PushNotificationNotificationParams } from '@stagewise/mcp-extension-push-notifications';
import {
  createPushNotificationsHttpSubscriptionManager,
  type PushNotificationsHttpSubscriptionManager,
  registerPushNotificationsServer,
} from '@stagewise/mcp-extension-push-notifications/server';

import type { EventStore } from './event-store.js';
import type { TelegramChannel } from './telegram.js';

export const MAX_MESSAGE_LENGTH = 4_000;

export interface TelegramMcp {
  fetch(request: Request): Promise<Response>;
  publish(params: PushNotificationNotificationParams): void;
  close(): Promise<void>;
}

export interface TelegramMcpOptions {
  onSubscriptionStateChanged?: (active: boolean) => void;
}

class TelegramMcpModule implements TelegramMcp {
  readonly #handler: ReturnType<typeof createMcpHandler>;
  readonly #subscriptions: PushNotificationsHttpSubscriptionManager;

  constructor(
    channel: TelegramChannel,
    eventStore: EventStore,
    options: TelegramMcpOptions,
  ) {
    this.#handler = createMcpHandler(
      () => {
        const server = new McpServer(
          { name: 'telegram', version: '0.1.0' },
          { capabilities: {} },
        );
        server.registerTool(
          'sendMessage',
          {
            description: 'Send a text message to a Telegram chat',
            inputSchema: z.object({
              chatId: z.string().trim().min(1),
              message: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
              replyToMessageId: z.string().trim().min(1).optional(),
            }),
          },
          async (input) => {
            const result = await channel.sendText(input);
            return {
              content: [
                { type: 'text', text: `Message sent: ${result.messageId}` },
              ],
            };
          },
        );
        registerPushNotificationsServer(server.server, {
          getEvents: ({ limit }) => eventStore.page({ limit }),
          acknowledgeEvents: ({ eventIds }) => eventStore.acknowledge(eventIds),
        });
        return server;
      },
      { legacy: 'stateless' },
    );
    this.#subscriptions = createPushNotificationsHttpSubscriptionManager(
      this.#handler.fetch,
      {
        resolveConsumerKey: () => 'runtime-agent',
        onSubscriptionStateChanged: (_consumerKey, active) =>
          options.onSubscriptionStateChanged?.(active),
      },
    );
  }

  fetch(request: Request): Promise<Response> {
    return this.#subscriptions.fetch(request);
  }

  publish(params: PushNotificationNotificationParams): void {
    this.#subscriptions.publish('runtime-agent', params);
  }

  async close(): Promise<void> {
    this.#subscriptions.close();
    await this.#handler.close();
  }
}

export function createTelegramMcp(
  channel: TelegramChannel,
  eventStore: EventStore,
  options: TelegramMcpOptions = {},
): TelegramMcp {
  return new TelegramMcpModule(channel, eventStore, options);
}
