import { Bot } from 'grammy';

import type { RootLogger } from '@stagewise/logger';

export interface InboundTextMessage {
  botId: string;
  updateId: string;
  messageId: string;
  chatId: string;
  senderId: string;
  text: string;
  receivedAt: string;
}

export type TelegramStatus = 'starting' | 'connected' | 'disconnected';

export interface TelegramChannel {
  start(): Promise<void>;
  sendText(input: {
    chatId: string;
    message: string;
    replyToMessageId?: string;
  }): Promise<{ messageId: string }>;
  status(): TelegramStatus;
  updateAllowedUserIds(allowedUserIds: ReadonlySet<string>): void;
  close(): Promise<void>;
}

interface RawTextMessage {
  updateId: number;
  messageId: number;
  chatId: number;
  chatType: string;
  senderId: number;
  senderIsBot: boolean;
  text: string;
  date: number;
}

export interface TelegramBot {
  getMe(): Promise<{ id: number }>;
  onText(listener: (message: RawTextMessage) => void | Promise<void>): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendText(
    chatId: string,
    message: string,
    replyToMessageId?: number,
  ): Promise<number>;
}

export interface TelegramChannelDependencies {
  token: string;
  allowedUserIds: ReadonlySet<string>;
  logging: RootLogger;
  onMessage(message: InboundTextMessage): void | Promise<void>;
  botFactory?: (token: string) => TelegramBot;
}

class TelegramChannelModule implements TelegramChannel {
  readonly #token: string;
  #allowedUserIds: ReadonlySet<string>;
  readonly #logger;
  readonly #onMessage: TelegramChannelDependencies['onMessage'];
  readonly #botFactory: NonNullable<TelegramChannelDependencies['botFactory']>;
  #state: TelegramStatus = 'disconnected';
  #bot?: TelegramBot;
  #started = false;

  constructor(deps: TelegramChannelDependencies) {
    this.#token = deps.token;
    this.#allowedUserIds = new Set(deps.allowedUserIds);
    this.#logger = deps.logging.child({
      name: 'telegram-channel',
      bindings: { module: 'telegram-channel' },
    });
    this.#onMessage = deps.onMessage;
    this.#botFactory = deps.botFactory ?? createGrammyBot;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    this.#state = 'starting';
    const bot = this.#botFactory(this.#token);
    this.#bot = bot;
    try {
      const identity = await bot.getMe();
      bot.onText((message) => this.#handleText(String(identity.id), message));
      this.#state = 'connected';
      void bot.start().catch(() => {
        if (!this.#started) return;
        this.#state = 'disconnected';
        this.#logger.error({}, 'Telegram polling failed');
      });
      this.#logger.info({ botId: identity.id }, 'Telegram connected');
    } catch (error) {
      this.#started = false;
      this.#bot = undefined;
      this.#state = 'disconnected';
      throw error;
    }
  }

  async sendText(input: {
    chatId: string;
    message: string;
    replyToMessageId?: string;
  }): Promise<{ messageId: string }> {
    if (this.#state !== 'connected' || !this.#bot) {
      throw new Error('Telegram is not connected');
    }
    if (!this.#allowedUserIds.has(input.chatId)) {
      throw new Error(`Telegram chat is not allowed: ${input.chatId}`);
    }
    const replyToMessageId = input.replyToMessageId
      ? parseInteger(input.replyToMessageId, 'replyToMessageId')
      : undefined;
    try {
      const messageId = await this.#bot.sendText(
        input.chatId,
        input.message,
        replyToMessageId,
      );
      return { messageId: String(messageId) };
    } catch {
      this.#logger.warn({}, 'Telegram message delivery failed');
      throw new Error('Telegram message delivery failed');
    }
  }

  status(): TelegramStatus {
    return this.#state;
  }

  updateAllowedUserIds(allowedUserIds: ReadonlySet<string>): void {
    this.#allowedUserIds = new Set(allowedUserIds);
  }

  async close(): Promise<void> {
    if (!this.#started) return;
    this.#started = false;
    const bot = this.#bot;
    this.#bot = undefined;
    if (bot) await bot.stop();
    this.#state = 'disconnected';
  }

  async #handleText(botId: string, message: RawTextMessage): Promise<void> {
    const senderId = String(message.senderId);
    const text = message.text.trim();
    if (
      message.chatType !== 'private' ||
      message.senderIsBot ||
      !this.#allowedUserIds.has(senderId) ||
      !text
    ) {
      return;
    }
    await this.#onMessage({
      botId,
      updateId: String(message.updateId),
      messageId: String(message.messageId),
      chatId: String(message.chatId),
      senderId,
      text,
      receivedAt: new Date(message.date * 1_000).toISOString(),
    });
  }
}

function createGrammyBot(token: string): TelegramBot {
  const bot = new Bot(token);
  return {
    getMe: () => bot.api.getMe(),
    onText(listener) {
      bot.on('message:text', (context) =>
        listener({
          updateId: context.update.update_id,
          messageId: context.message.message_id,
          chatId: context.chat.id,
          chatType: context.chat.type,
          senderId: context.from.id,
          senderIsBot: context.from.is_bot,
          text: context.message.text,
          date: context.message.date,
        }),
      );
    },
    start: () => bot.start(),
    stop: () => bot.stop(),
    async sendText(chatId, message, replyToMessageId) {
      const sent = await bot.api.sendMessage(chatId, message, {
        reply_parameters:
          replyToMessageId === undefined
            ? undefined
            : { message_id: replyToMessageId },
      });
      return sent.message_id;
    },
  };
}

function parseInteger(value: string, name: string): number {
  if (!/^-?\d+$/.test(value)) throw new Error(`Invalid ${name}: ${value}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed))
    throw new Error(`Invalid ${name}: ${value}`);
  return parsed;
}

export function createTelegramChannel(
  deps: TelegramChannelDependencies,
): TelegramChannel {
  return new TelegramChannelModule(deps);
}
