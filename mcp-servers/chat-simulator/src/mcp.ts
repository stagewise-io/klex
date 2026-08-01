import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';

import type { PushNotificationNotificationParams } from '@stagewise/mcp-extension-push-notifications';
import {
  createPushNotificationsHttpSubscriptionManager,
  type PushNotificationsHttpSubscriptionManager,
  registerPushNotificationsServer,
} from '@stagewise/mcp-extension-push-notifications/server';
import type {
  AcceptRealtimeMediaSessionResult,
  RealtimeMediaSessionEndedNotificationParams,
  RealtimeMediaSessionOfferedNotificationParams,
} from '@stagewise/mcp-extension-realtime-media';
import {
  createRealtimeMediaHttpSubscriptionManager,
  type RealtimeMediaHttpSubscriptionManager,
  registerRealtimeMediaServer,
} from '@stagewise/mcp-extension-realtime-media/server';

import type { ChatStore } from './chat-store.js';
import { MAX_MESSAGE_LENGTH } from './chat-store.js';
import {
  createRealtimeSessionStore,
  type RealtimeSessionStore,
} from './realtime-session-store.js';

const LOCAL_CONSUMER_KEY = 'local-agent';

export interface RealtimeOfferResult {
  session: RealtimeMediaSessionOfferedNotificationParams;
  participant?: AcceptRealtimeMediaSessionResult;
}

export interface ChatMcp {
  fetch(request: Request): Promise<Response>;
  publishUserEvent(params: PushNotificationNotificationParams): void;
  createRealtimeOffer(): Promise<RealtimeOfferResult>;
  endRealtimeSession(
    sessionId: string,
    reason?: string,
  ): RealtimeMediaSessionEndedNotificationParams;
  close(): Promise<void>;
}

class ChatMcpModule implements ChatMcp {
  readonly #handler: ReturnType<typeof createMcpHandler>;
  readonly #pushSubscriptions: PushNotificationsHttpSubscriptionManager;
  readonly #realtimeSubscriptions: RealtimeMediaHttpSubscriptionManager;

  constructor(
    store: ChatStore,
    private readonly realtimeSessions: RealtimeSessionStore,
    private readonly issueBrowserTransport?: (
      sessionId: string,
    ) => Promise<AcceptRealtimeMediaSessionResult>,
  ) {
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
        registerPushNotificationsServer(server.server, {
          getEvents: ({ limit }) => store.getEvents({ limit }),
          acknowledgeEvents: ({ eventIds }) =>
            store.acknowledgeEvents(eventIds),
        });
        registerRealtimeMediaServer(
          server.server,
          {
            accept: ({ sessionId }) =>
              this.realtimeSessions.accept(LOCAL_CONSUMER_KEY, sessionId),
            reject: ({ sessionId }) =>
              this.realtimeSessions.reject(LOCAL_CONSUMER_KEY, sessionId),
            end: ({ sessionId }) =>
              this.realtimeSessions.end(LOCAL_CONSUMER_KEY, sessionId),
          },
          { registerDiscoveryHandler: false },
        );
        return server;
      },
      { legacy: 'stateless' },
    );
    this.#pushSubscriptions = createPushNotificationsHttpSubscriptionManager(
      this.#handler.fetch,
      { resolveConsumerKey: () => LOCAL_CONSUMER_KEY },
    );
    this.#realtimeSubscriptions = createRealtimeMediaHttpSubscriptionManager(
      this.#pushSubscriptions.fetch.bind(this.#pushSubscriptions),
      {
        resolveConsumerKey: () => LOCAL_CONSUMER_KEY,
        onSubscriptionStateChanged: (consumerKey, active) => {
          if (!active) this.realtimeSessions.endConsumer(consumerKey);
        },
      },
    );
  }

  fetch(request: Request): Promise<Response> {
    return this.#realtimeSubscriptions.fetch(request);
  }

  publishUserEvent(params: PushNotificationNotificationParams): void {
    this.#pushSubscriptions.publish(LOCAL_CONSUMER_KEY, params);
  }

  async createRealtimeOffer(): Promise<RealtimeOfferResult> {
    const session = this.realtimeSessions.createOffer(LOCAL_CONSUMER_KEY);
    const participant = await this.issueBrowserTransport?.(session.sessionId);
    this.#realtimeSubscriptions.publishSessionOffered(
      LOCAL_CONSUMER_KEY,
      session,
    );
    return { session, ...(participant ? { participant } : {}) };
  }

  endRealtimeSession(
    sessionId: string,
    reason?: string,
  ): RealtimeMediaSessionEndedNotificationParams {
    const ended = this.realtimeSessions.remoteEnd(
      LOCAL_CONSUMER_KEY,
      sessionId,
      reason,
    );
    this.#realtimeSubscriptions.publishSessionEnded(LOCAL_CONSUMER_KEY, ended);
    return ended;
  }

  async close(): Promise<void> {
    this.#realtimeSubscriptions.close();
    this.#pushSubscriptions.close();
    this.realtimeSessions.close();
    await this.#handler.close();
  }
}

export function createChatMcp(
  store: ChatStore,
  realtimeSessions: RealtimeSessionStore = createRealtimeSessionStore(),
  issueBrowserTransport?: (
    sessionId: string,
  ) => Promise<AcceptRealtimeMediaSessionResult>,
): ChatMcp {
  return new ChatMcpModule(store, realtimeSessions, issueBrowserTransport);
}
