import type {
  GetEventsResult,
  PushNotification,
  PushNotificationNotificationParams,
} from '@stagewise/mcp-extension-push-notifications';

import type { InboundTextMessage } from './telegram.js';

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1_000;

export interface EventStore {
  append(message: InboundTextMessage): PushNotificationNotificationParams;
  page(options?: { limit?: number }): GetEventsResult;
  acknowledge(eventIds: string[]): void;
  close(): void;
}

class EventStoreModule implements EventStore {
  readonly #events: PushNotification[] = [];
  readonly #acknowledged = new Set<string>();

  append(message: InboundTextMessage): PushNotificationNotificationParams {
    const event: PushNotification = {
      eventId: `telegram:${message.botId}:update:${message.updateId}`,
      sourceId: `telegram:${message.botId}`,
      type: 'chat.message.received',
      createdAt: message.receivedAt,
      payload: {
        messageId: message.messageId,
        updateId: message.updateId,
        chatId: message.chatId,
        senderId: message.senderId,
        message: message.text,
      },
    };
    const existing = this.#events.find(
      (candidate) => candidate.eventId === event.eventId,
    );
    if (existing) return { event: this.#copy(existing) };
    this.#events.push(event);
    return { event: this.#copy(event) };
  }

  page(options: { limit?: number } = {}): GetEventsResult {
    const requestedLimit = options.limit ?? DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
      throw new RangeError('Event page limit must be a positive integer');
    }
    const limit = Math.min(requestedLimit, MAX_PAGE_SIZE);
    const pending = this.#events.filter(
      (event) => !this.#acknowledged.has(event.eventId),
    );
    return {
      events: pending.slice(0, limit).map((event) => this.#copy(event)),
      hasMore: pending.length > limit,
    };
  }

  acknowledge(eventIds: string[]): void {
    for (const eventId of eventIds) this.#acknowledged.add(eventId);
  }

  close(): void {
    this.#events.length = 0;
    this.#acknowledged.clear();
  }

  #copy(event: PushNotification): PushNotification {
    return { ...event, payload: { ...event.payload } };
  }
}

/** In-memory only: restarting the process clears events and acknowledgements. */
export function createEventStore(): EventStore {
  return new EventStoreModule();
}
