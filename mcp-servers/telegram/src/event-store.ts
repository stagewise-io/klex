import type {
  GetEventsResult,
  PushNotification,
  PushNotificationNotificationParams,
} from '@stagewise/mcp-extension-push-notifications';

import type {
  InboundMediaMessage,
  InboundTelegramMessage,
  TelegramMediaStatus,
} from './telegram.js';

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1_000;
const DEFAULT_PENDING_MEDIA_MAX_BYTES = 50 * 1024 * 1024;

export interface AppendResult {
  notification: PushNotificationNotificationParams;
  isNew: boolean;
}

export interface EventStoreOptions {
  pendingMediaMaxBytes?: number;
}

export interface EventStore {
  append(message: InboundTelegramMessage): AppendResult;
  page(options?: { limit?: number }): GetEventsResult;
  query(options?: {
    chatId?: string;
    senderId?: string;
    kind?: 'text' | 'photo' | 'audio' | 'voice';
    limit?: number;
  }): GetEventsResult;
  acknowledge(eventIds: string[]): void;
  close(): void;
}

interface PendingEvent {
  event: PushNotification;
  mediaBytes: number;
}

class EventStoreModule implements EventStore {
  readonly #pending: PendingEvent[] = [];
  readonly #seenEventIds = new Set<string>();
  readonly #pendingMediaMaxBytes: number;
  #pendingMediaBytes = 0;

  constructor(options: EventStoreOptions) {
    this.#pendingMediaMaxBytes =
      options.pendingMediaMaxBytes ?? DEFAULT_PENDING_MEDIA_MAX_BYTES;
  }

  append(message: InboundTelegramMessage): AppendResult {
    const eventId = `telegram:${message.botId}:update:${message.updateId}`;
    if (this.#seenEventIds.has(eventId)) {
      const existing = this.#pending.find(
        (candidate) => candidate.event.eventId === eventId,
      )?.event;
      return {
        notification: { event: this.#copy(existing ?? createEvent(message)) },
        isNew: false,
      };
    }

    let acceptedMessage = message;
    let mediaBytes = includedMediaBytes(message);
    if (
      message.kind !== 'text' &&
      mediaBytes > 0 &&
      this.#pendingMediaBytes + mediaBytes > this.#pendingMediaMaxBytes
    ) {
      acceptedMessage = {
        ...message,
        mediaData: undefined,
        mediaSize: undefined,
        mediaStatus: 'omitted_queue_budget',
      };
      mediaBytes = 0;
    }
    const event = createEvent(acceptedMessage);
    this.#seenEventIds.add(event.eventId);
    this.#pending.push({ event, mediaBytes });
    this.#pendingMediaBytes += mediaBytes;
    return { notification: { event: this.#copy(event) }, isNew: true };
  }

  page(options: { limit?: number } = {}): GetEventsResult {
    const requestedLimit = options.limit ?? DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
      throw new RangeError('Event page limit must be a positive integer');
    }
    const limit = Math.min(requestedLimit, MAX_PAGE_SIZE);
    return {
      events: this.#pending
        .slice(0, limit)
        .map(({ event }) => this.#copy(event)),
      hasMore: this.#pending.length > limit,
    };
  }

  query(
    options: {
      chatId?: string;
      senderId?: string;
      kind?: 'text' | 'photo' | 'audio' | 'voice';
      limit?: number;
    } = {},
  ): GetEventsResult {
    const requestedLimit = options.limit ?? DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
      throw new RangeError('Event query limit must be a positive integer');
    }
    let indices = this.#pending.map((_, index) => index);
    if (options.chatId) {
      indices = indices.filter((index) => {
        const event = this.#pending[index]!.event;
        return event.data?.chatId === options.chatId;
      });
    }
    if (options.senderId) {
      indices = indices.filter((index) => {
        const event = this.#pending[index]!.event;
        return event.data?.senderId === options.senderId;
      });
    }
    if (options.kind) {
      indices = indices.filter((index) => {
        const event = this.#pending[index]!.event;
        return options.kind === 'text'
          ? !event.data?.mediaKind
          : event.data?.mediaKind === options.kind;
      });
    }
    const limit = Math.min(requestedLimit, MAX_PAGE_SIZE);
    return {
      events: indices
        .slice(0, limit)
        .map((index) => this.#copy(this.#pending[index]!.event)),
      hasMore: indices.length > limit,
    };
  }

  acknowledge(eventIds: string[]): void {
    const acknowledged = new Set(eventIds);
    for (let index = this.#pending.length - 1; index >= 0; index -= 1) {
      const pending = this.#pending[index];
      if (!pending || !acknowledged.has(pending.event.eventId)) continue;
      this.#pendingMediaBytes -= pending.mediaBytes;
      this.#pending.splice(index, 1);
    }
  }

  close(): void {
    this.#pending.length = 0;
    this.#seenEventIds.clear();
    this.#pendingMediaBytes = 0;
  }

  #copy(event: PushNotification): PushNotification {
    return structuredClone(event);
  }
}

function createEvent(message: InboundTelegramMessage): PushNotification {
  const data: NonNullable<PushNotification['data']> = {
    messageId: message.messageId,
    updateId: message.updateId,
    chatId: message.chatId,
    senderId: message.senderId,
  };
  let content: PushNotification['content'];
  if (message.kind === 'text') {
    content = [{ type: 'text', text: message.text }];
  } else {
    content = createMediaContent(message);
    data.mediaKind = message.kind;
    data.mediaStatus = message.mediaStatus;
    if (message.mediaSize !== undefined) data.mediaSize = message.mediaSize;
  }
  return {
    eventId: `telegram:${message.botId}:update:${message.updateId}`,
    sourceId: `telegram:${message.botId}`,
    type: 'chat.message.received',
    createdAt: message.receivedAt,
    content,
    data,
  };
}

function createMediaContent(
  message: InboundMediaMessage,
): PushNotification['content'] {
  const content: PushNotification['content'] = [];
  if (message.caption) content.push({ type: 'text', text: message.caption });
  if (
    message.mediaStatus === 'included' &&
    message.mediaData &&
    message.mimeType
  ) {
    content.push(
      message.kind === 'photo'
        ? {
            type: 'image',
            data: message.mediaData,
            mimeType: message.mimeType,
          }
        : {
            type: 'audio',
            data: message.mediaData,
            mimeType: message.mimeType,
          },
    );
  } else {
    content.push({
      type: 'text',
      text: omissionMessage(message.kind, message.mediaStatus),
    });
  }
  return content;
}

function omissionMessage(
  kind: InboundMediaMessage['kind'],
  status: Exclude<TelegramMediaStatus, 'included'> | 'included',
): string {
  const reason = {
    included: 'could not be included',
    omitted_too_large: 'exceeded the per-file size limit',
    omitted_unsupported_type: 'had an unsupported media type',
    omitted_download_failed: 'could not be downloaded',
    omitted_queue_budget: 'exceeded the pending media budget',
  }[status];
  return `[Telegram ${kind} omitted: ${reason}.]`;
}

function includedMediaBytes(message: InboundTelegramMessage): number {
  return message.kind !== 'text' && message.mediaStatus === 'included'
    ? (message.mediaSize ??
        Buffer.byteLength(message.mediaData ?? '', 'base64'))
    : 0;
}

/** In-memory only: restarting the process clears events and deduplication state. */
export function createEventStore(options: EventStoreOptions = {}): EventStore {
  return new EventStoreModule(options);
}
