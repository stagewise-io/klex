import { Bot } from 'grammy';

import type { RootLogger } from '@stagewise/logger';

export type TelegramMediaKind = 'photo' | 'audio' | 'voice';
export type TelegramMediaStatus =
  | 'included'
  | 'omitted_too_large'
  | 'omitted_unsupported_type'
  | 'omitted_download_failed'
  | 'omitted_queue_budget';

interface InboundMessageBase {
  botId: string;
  updateId: string;
  messageId: string;
  chatId: string;
  senderId: string;
  receivedAt: string;
}

export interface InboundTextMessage extends InboundMessageBase {
  kind: 'text';
  text: string;
}

export interface InboundMediaMessage extends InboundMessageBase {
  kind: TelegramMediaKind;
  caption?: string;
  mimeType?: string;
  mediaData?: string;
  mediaSize?: number;
  mediaStatus: TelegramMediaStatus;
}

export type InboundTelegramMessage = InboundTextMessage | InboundMediaMessage;

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

interface RawMessageBase {
  updateId: number;
  messageId: number;
  chatId: number;
  chatType: string;
  senderId: number;
  senderIsBot: boolean;
  date: number;
}

export type RawTelegramMessage = RawMessageBase &
  (
    | { kind: 'text'; text: string }
    | {
        kind: TelegramMediaKind;
        fileId: string;
        fileSize?: number;
        mimeType?: string;
        caption?: string;
      }
  );

export type TelegramFileDownloadResult =
  | { status: 'included'; bytes: Uint8Array }
  | { status: 'omitted_too_large' | 'omitted_download_failed' };

export interface TelegramBot {
  getMe(): Promise<{ id: number }>;
  onMessage(
    listener: (message: RawTelegramMessage) => void | Promise<void>,
  ): void;
  downloadFile(input: {
    fileId: string;
    maxBytes: number;
    timeoutMs: number;
  }): Promise<TelegramFileDownloadResult>;
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
  onMessage(message: InboundTelegramMessage): void | Promise<void>;
  mediaMaxBytes?: number;
  mediaDownloadTimeoutMs?: number;
  botFactory?: (token: string) => TelegramBot;
}

const DEFAULT_MEDIA_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MEDIA_DOWNLOAD_TIMEOUT_MS = 15_000;

class TelegramChannelModule implements TelegramChannel {
  readonly #token: string;
  #allowedUserIds: ReadonlySet<string>;
  #isWildcard = false;
  readonly #logger;
  readonly #onMessage: TelegramChannelDependencies['onMessage'];
  readonly #mediaMaxBytes: number;
  readonly #mediaDownloadTimeoutMs: number;
  readonly #botFactory: NonNullable<TelegramChannelDependencies['botFactory']>;
  #state: TelegramStatus = 'disconnected';
  #bot?: TelegramBot;
  #started = false;

  constructor(deps: TelegramChannelDependencies) {
    this.#token = deps.token;
    this.#allowedUserIds = new Set(deps.allowedUserIds);
    this.#isWildcard = this.#allowedUserIds.has('*');
    this.#logger = deps.logging.child({
      name: 'telegram-channel',
      bindings: { module: 'telegram-channel' },
    });
    this.#onMessage = deps.onMessage;
    this.#mediaMaxBytes = deps.mediaMaxBytes ?? DEFAULT_MEDIA_MAX_BYTES;
    this.#mediaDownloadTimeoutMs =
      deps.mediaDownloadTimeoutMs ?? DEFAULT_MEDIA_DOWNLOAD_TIMEOUT_MS;
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
      bot.onMessage((message) =>
        this.#handleMessage(String(identity.id), message),
      );
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
    if (!this.#isWildcard && !this.#allowedUserIds.has(input.chatId)) {
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
    this.#isWildcard = this.#allowedUserIds.has('*');
  }

  async close(): Promise<void> {
    if (!this.#started) return;
    this.#started = false;
    const bot = this.#bot;
    this.#bot = undefined;
    if (bot) await bot.stop();
    this.#state = 'disconnected';
  }

  async #handleMessage(
    botId: string,
    message: RawTelegramMessage,
  ): Promise<void> {
    const senderId = String(message.senderId);
    if (
      message.senderIsBot ||
      (!this.#isWildcard && !this.#allowedUserIds.has(senderId))
    ) {
      return;
    }

    const common = {
      botId,
      updateId: String(message.updateId),
      messageId: String(message.messageId),
      chatId: String(message.chatId),
      senderId,
      receivedAt: new Date(message.date * 1_000).toISOString(),
    };
    if (message.kind === 'text') {
      const text = message.text.trim();
      if (!text) return;
      await this.#onMessage({ ...common, kind: 'text', text });
      return;
    }

    const caption = message.caption?.trim() || undefined;
    const mimeType = resolveMimeType(message.kind, message.mimeType);
    if (!mimeType) {
      await this.#onMessage({
        ...common,
        kind: message.kind,
        caption,
        mediaStatus: 'omitted_unsupported_type',
      });
      return;
    }
    if (
      message.fileSize !== undefined &&
      message.fileSize > this.#mediaMaxBytes
    ) {
      await this.#onMessage({
        ...common,
        kind: message.kind,
        caption,
        mimeType,
        mediaStatus: 'omitted_too_large',
      });
      return;
    }

    const result = await this.#bot?.downloadFile({
      fileId: message.fileId,
      maxBytes: this.#mediaMaxBytes,
      timeoutMs: this.#mediaDownloadTimeoutMs,
    });
    if (result?.status !== 'included') {
      const mediaStatus = result?.status ?? 'omitted_download_failed';
      if (mediaStatus === 'omitted_download_failed') {
        this.#logger.warn(
          { mediaKind: message.kind },
          'Telegram media download failed',
        );
      }
      await this.#onMessage({
        ...common,
        kind: message.kind,
        caption,
        mimeType,
        mediaStatus,
      });
      return;
    }

    await this.#onMessage({
      ...common,
      kind: message.kind,
      caption,
      mimeType,
      mediaData: Buffer.from(result.bytes).toString('base64'),
      mediaSize: result.bytes.byteLength,
      mediaStatus: 'included',
    });
  }
}

function createGrammyBot(token: string): TelegramBot {
  const bot = new Bot(token);
  return {
    getMe: () => bot.api.getMe(),
    onMessage(listener) {
      bot.on('message:text', (context) =>
        listener({
          kind: 'text',
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
      bot.on('message:photo', (context) => {
        const photo = selectLargestPhoto(context.message.photo);
        if (!photo) return;
        return listener({
          kind: 'photo',
          updateId: context.update.update_id,
          messageId: context.message.message_id,
          chatId: context.chat.id,
          chatType: context.chat.type,
          senderId: context.from.id,
          senderIsBot: context.from.is_bot,
          fileId: photo.file_id,
          fileSize: photo.file_size,
          caption: context.message.caption,
          date: context.message.date,
        });
      });
      bot.on('message:audio', (context) =>
        listener({
          kind: 'audio',
          updateId: context.update.update_id,
          messageId: context.message.message_id,
          chatId: context.chat.id,
          chatType: context.chat.type,
          senderId: context.from.id,
          senderIsBot: context.from.is_bot,
          fileId: context.message.audio.file_id,
          fileSize: context.message.audio.file_size,
          mimeType: context.message.audio.mime_type,
          caption: context.message.caption,
          date: context.message.date,
        }),
      );
      bot.on('message:voice', (context) =>
        listener({
          kind: 'voice',
          updateId: context.update.update_id,
          messageId: context.message.message_id,
          chatId: context.chat.id,
          chatType: context.chat.type,
          senderId: context.from.id,
          senderIsBot: context.from.is_bot,
          fileId: context.message.voice.file_id,
          fileSize: context.message.voice.file_size,
          mimeType: context.message.voice.mime_type,
          caption: context.message.caption,
          date: context.message.date,
        }),
      );
    },
    downloadFile: ({ fileId, maxBytes, timeoutMs }) =>
      downloadTelegramFile({
        token,
        fileId,
        maxBytes,
        timeoutMs,
        getFile: (id) => bot.api.getFile(id),
        fetchFile: fetch,
      }),
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

export interface DownloadTelegramFileOptions {
  token: string;
  fileId: string;
  maxBytes: number;
  timeoutMs: number;
  getFile(fileId: string): Promise<{
    file_path?: string;
    file_size?: number;
  }>;
  fetchFile: typeof fetch;
}

export async function downloadTelegramFile({
  token,
  fileId,
  maxBytes,
  timeoutMs,
  getFile,
  fetchFile,
}: DownloadTelegramFileOptions): Promise<TelegramFileDownloadResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const file = await Promise.race([
      getFile(fileId),
      abortResult(controller.signal),
    ]);
    if ('aborted' in file) return { status: 'omitted_download_failed' };
    if (file.file_size !== undefined && file.file_size > maxBytes) {
      return { status: 'omitted_too_large' };
    }
    if (!file.file_path) return { status: 'omitted_download_failed' };
    const response = await Promise.race([
      fetchFile(`https://api.telegram.org/file/bot${token}/${file.file_path}`, {
        signal: controller.signal,
      }),
      abortResult(controller.signal),
    ]);
    if ('aborted' in response) return { status: 'omitted_download_failed' };
    if (!response.ok || !response.body) {
      return { status: 'omitted_download_failed' };
    }
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      await response.body.cancel();
      return { status: 'omitted_too_large' };
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    const aborted = abortResult(controller.signal);
    while (true) {
      const chunk = await Promise.race([reader.read(), aborted]);
      if ('aborted' in chunk) {
        await reader.cancel();
        return { status: 'omitted_download_failed' };
      }
      if (chunk.done) break;
      byteLength += chunk.value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel();
        return { status: 'omitted_too_large' };
      }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { status: 'included', bytes };
  } catch {
    return { status: 'omitted_download_failed' };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function abortResult(signal: AbortSignal): Promise<{ aborted: true }> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve({ aborted: true });
    else {
      signal.addEventListener('abort', () => resolve({ aborted: true }), {
        once: true,
      });
    }
  });
}

export function selectLargestPhoto<
  Photo extends { file_id: string; file_size?: number },
>(photos: readonly Photo[]): Photo | undefined {
  return photos.at(-1);
}

function resolveMimeType(
  kind: TelegramMediaKind,
  declaredMimeType?: string,
): string | undefined {
  if (kind === 'photo') return 'image/jpeg';
  if (kind === 'voice' && declaredMimeType === undefined) return 'audio/ogg';
  if (declaredMimeType?.toLowerCase().startsWith('audio/')) {
    return declaredMimeType.toLowerCase();
  }
  return undefined;
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
