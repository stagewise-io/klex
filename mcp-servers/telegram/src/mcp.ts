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
export const MAX_CAPTION_LENGTH = 1_024;
export const MAX_VOICE_BYTES = 50 * 1024 * 1024;
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
export const MAX_NAME_LENGTH = 64;
export const MAX_DESCRIPTION_LENGTH = 512;
export const MAX_SHORT_DESCRIPTION_LENGTH = 120;
export const MAX_QUERY_LIMIT = 1_000;

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
            description:
              'Send a text message to a Telegram chat. ' +
              'The message must be 1-4,000 characters. ' +
              'The chatId must be in the runtime allowlist.',
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
        server.registerTool(
          'sendVoice',
          {
            description:
              'Send a voice message (OGG/OPUS) to a Telegram chat. ' +
              'The voice data must be base64-encoded, max 50 MB decoded. ' +
              'Caption is optional, 1-1,024 characters. ' +
              'The chatId must be in the runtime allowlist.',
            inputSchema: z.object({
              chatId: z.string().trim().min(1),
              voiceData: z
                .string()
                .min(1)
                .refine((value) => {
                  const bytes = Buffer.from(value, 'base64').byteLength;
                  return bytes > 0 && bytes <= MAX_VOICE_BYTES;
                }, `Voice data must be 1-${MAX_VOICE_BYTES} decoded bytes`),
              caption: z
                .string()
                .trim()
                .min(1)
                .max(MAX_CAPTION_LENGTH)
                .optional(),
              duration: z.number().int().min(0).max(3600).optional(),
              replyToMessageId: z.string().trim().min(1).optional(),
            }),
          },
          async (input) => {
            const result = await channel.sendVoice(input);
            return {
              content: [
                {
                  type: 'text',
                  text: `Voice message sent: ${result.messageId}`,
                },
              ],
            };
          },
        );

        server.registerTool(
          'sendPhoto',
          {
            description:
              'Send a photo to a Telegram chat. ' +
              'The photo data must be base64-encoded, max 10 MB decoded. ' +
              'The photo dimensions must not exceed 10,000 px total (width + height). ' +
              'Caption is optional, 1-1,024 characters. ' +
              'The chatId must be in the runtime allowlist.',
            inputSchema: z.object({
              chatId: z.string().trim().min(1),
              photoData: z
                .string()
                .min(1)
                .refine((value) => {
                  const bytes = Buffer.from(value, 'base64').byteLength;
                  return bytes > 0 && bytes <= MAX_PHOTO_BYTES;
                }, `Photo data must be 1-${MAX_PHOTO_BYTES} decoded bytes`),
              caption: z
                .string()
                .trim()
                .min(1)
                .max(MAX_CAPTION_LENGTH)
                .optional(),
              replyToMessageId: z.string().trim().min(1).optional(),
            }),
          },
          async (input) => {
            const result = await channel.sendPhoto(input);
            return {
              content: [
                { type: 'text', text: `Photo sent: ${result.messageId}` },
              ],
            };
          },
        );

        server.registerTool(
          'getChatInfo',
          {
            description:
              'Fetch information about a Telegram chat (type, username, title, etc.). ' +
              'Works for any chat the bot is a member of; the chatId does not need to be in the allowlist.',
            inputSchema: z.object({
              chatId: z.string().trim().min(1),
            }),
          },
          async (input) => {
            const chat = await channel.getChat(input.chatId);
            return {
              content: [{ type: 'text', text: JSON.stringify(chat) }],
            };
          },
        );

        server.registerTool(
          'getChatHistory',
          {
            description:
              'Retrieve pending (unacknowledged) inbound messages with optional filters. ' +
              'Note: the Telegram Bot API does not expose full server-side chat history; ' +
              'this returns only messages received by the bot since the current runtime started and not yet acknowledged. ' +
              'Use limit to control page size (max 1,000). ' +
              'Results are returned oldest-first.',
            inputSchema: z.object({
              chatId: z.string().trim().min(1).optional(),
              senderId: z.string().trim().min(1).optional(),
              kind: z.enum(['text', 'photo', 'audio', 'voice']).optional(),
              limit: z.number().int().min(1).max(MAX_QUERY_LIMIT).optional(),
            }),
          },
          async (input) => {
            const result = eventStore.query(input);
            const summary = {
              count: result.events.length,
              hasMore: result.hasMore,
              events: result.events.map((event) => ({
                eventId: event.eventId,
                type: event.type,
                createdAt: event.createdAt,
                data: event.data,
                content: event.content,
              })),
            };
            return {
              content: [{ type: 'text', text: JSON.stringify(summary) }],
            };
          },
        );

        server.registerTool(
          'getMyProfile',
          {
            description:
              "Get the bot's current profile (name, description, short description)",
            inputSchema: z.object({}),
          },
          async () => {
            const profile = await channel.getMyProfile();
            return {
              content: [{ type: 'text', text: JSON.stringify(profile) }],
            };
          },
        );

        server.registerTool(
          'setMyName',
          {
            description: "Set the bot's display name (0-64 characters)",
            inputSchema: z.object({
              name: z.string().trim().min(0).max(MAX_NAME_LENGTH),
            }),
          },
          async (input) => {
            await channel.setMyName(input.name);
            return {
              content: [{ type: 'text', text: 'Bot name updated' }],
            };
          },
        );

        server.registerTool(
          'setMyDescription',
          {
            description:
              "Set the bot's description shown in the chat with the bot (0-512 characters)",
            inputSchema: z.object({
              description: z.string().trim().min(0).max(MAX_DESCRIPTION_LENGTH),
            }),
          },
          async (input) => {
            await channel.setMyDescription(input.description);
            return {
              content: [{ type: 'text', text: 'Bot description updated' }],
            };
          },
        );

        server.registerTool(
          'setMyShortDescription',
          {
            description:
              "Set the bot's short description shown on the profile page (0-120 characters)",
            inputSchema: z.object({
              shortDescription: z
                .string()
                .trim()
                .min(0)
                .max(MAX_SHORT_DESCRIPTION_LENGTH),
            }),
          },
          async (input) => {
            await channel.setMyShortDescription(input.shortDescription);
            return {
              content: [
                { type: 'text', text: 'Bot short description updated' },
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
