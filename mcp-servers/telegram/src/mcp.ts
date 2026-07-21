import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';

import {
  createFluidEventsHttpSubscriptionManager,
  type FluidEventsHttpSubscriptionManager,
  registerFluidEventsServer,
} from '@stagewise/mcp-extension-fluid-events/server';

import type { EventStore } from './event-store.js';
import type { TelegramChannel } from './telegram.js';

export const MAX_MESSAGE_LENGTH = 4_000;

export interface TelegramMcp {
  fetch(request: Request): Promise<Response>;
  publish: FluidEventsHttpSubscriptionManager['publish'];
  close(): Promise<void>;
}

class TelegramMcpModule implements TelegramMcp {
  readonly #handler: ReturnType<typeof createMcpHandler>;
  readonly #subscriptions: FluidEventsHttpSubscriptionManager;

  constructor(channel: TelegramChannel, eventStore: EventStore) {
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
        registerFluidEventsServer(server.server, {
          getEvents: ({ cursor, limit }) => eventStore.page({ cursor, limit }),
          acknowledgeEvents: ({ eventIds }) => eventStore.acknowledge(eventIds),
        });
        return server;
      },
      { legacy: 'stateless' },
    );
    this.#subscriptions = createFluidEventsHttpSubscriptionManager(
      this.#handler.fetch,
    );
  }

  fetch(request: Request): Promise<Response> {
    return this.#subscriptions.fetch(request);
  }

  publish: FluidEventsHttpSubscriptionManager['publish'] = (params) =>
    this.#subscriptions.publish(params);

  async close(): Promise<void> {
    this.#subscriptions.close();
    await this.#handler.close();
  }
}

export function createTelegramMcp(
  channel: TelegramChannel,
  eventStore: EventStore,
): TelegramMcp {
  return new TelegramMcpModule(channel, eventStore);
}
