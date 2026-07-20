import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import {
  createFluidEventsHttpSubscriptionManager,
  type FluidEventsHttpSubscriptionManager,
  registerFluidEventsServer,
} from '@stagewise/mcp-extension-fluid-events/server';
import { z } from 'zod/v4';
import type { ChatStore } from './chat-store.js';
import { MAX_MESSAGE_LENGTH } from './chat-store.js';

export interface ChatMcp {
  fetch(request: Request): Promise<Response>;
  publishUserEvent: FluidEventsHttpSubscriptionManager['publish'];
  close(): Promise<void>;
}

class ChatMcpModule implements ChatMcp {
  readonly #handler: ReturnType<typeof createMcpHandler>;
  readonly #subscriptions: FluidEventsHttpSubscriptionManager;

  constructor(store: ChatStore) {
    this.#handler = createMcpHandler(
      () => {
        const server = new McpServer(
          { name: 'chat-simulator', version: '0.1.0' },
          { capabilities: {} },
        );
        server.registerTool(
          'sendMessage',
          {
            description: 'Send a message to the chat user',
            inputSchema: z.object({
              message: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
            }),
          },
          ({ message }) => {
            const created = store.addAgentMessage(message);
            return {
              content: [{ type: 'text', text: `Message sent: ${created.id}` }],
            };
          },
        );
        registerFluidEventsServer(server.server, {
          getEvents: ({ cursor, limit }) => store.getEvents({ cursor, limit }),
          acknowledgeEvents: ({ eventIds }) =>
            store.acknowledgeEvents(eventIds),
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

  publishUserEvent: FluidEventsHttpSubscriptionManager['publish'] = (params) =>
    this.#subscriptions.publish(params);

  async close(): Promise<void> {
    this.#subscriptions.close();
    await this.#handler.close();
  }
}

export function createChatMcp(store: ChatStore): ChatMcp {
  return new ChatMcpModule(store);
}
