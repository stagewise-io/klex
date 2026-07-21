import type {
  FluidEvent,
  FluidEventNotificationParams,
  GetEventsResult,
} from '@stagewise/mcp-extension-fluid-events';

import type { InboundTextMessage } from './telegram.js';

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1_000;

export interface EventStore {
  append(message: InboundTextMessage): FluidEventNotificationParams;
  page(options?: { cursor?: string; limit?: number }): GetEventsResult;
  acknowledge(eventIds: string[]): void;
  close(): void;
}

export class InvalidCursorError extends Error {
  constructor(cursor: string) {
    super(`Invalid event cursor: ${cursor}`);
    this.name = 'InvalidCursorError';
  }
}

export class UnknownEventError extends Error {
  constructor(eventId: string) {
    super(`Unknown event: ${eventId}`);
    this.name = 'UnknownEventError';
  }
}

class EventStoreModule implements EventStore {
  readonly #events: FluidEvent[] = [];
  readonly #eventIds = new Set<string>();
  readonly #acknowledged = new Set<string>();

  append(message: InboundTextMessage): FluidEventNotificationParams {
    const event: FluidEvent = {
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
    if (existing) {
      return {
        event: this.#copy(existing),
        cursor: String(this.#events.indexOf(existing) + 1),
      };
    }
    this.#events.push(event);
    this.#eventIds.add(event.eventId);
    return { event: this.#copy(event), cursor: String(this.#events.length) };
  }

  page(options: { cursor?: string; limit?: number } = {}): GetEventsResult {
    const position = this.#parseCursor(options.cursor ?? '0');
    const requestedLimit = options.limit ?? DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
      throw new RangeError('Event page limit must be a positive integer');
    }
    const events = this.#events
      .slice(position, position + Math.min(requestedLimit, MAX_PAGE_SIZE))
      .map((event) => this.#copy(event));
    const nextPosition = position + events.length;
    return {
      events,
      nextCursor: String(nextPosition),
      hasMore: nextPosition < this.#events.length,
    };
  }

  acknowledge(eventIds: string[]): void {
    for (const eventId of eventIds) {
      if (!this.#eventIds.has(eventId)) throw new UnknownEventError(eventId);
    }
    for (const eventId of eventIds) this.#acknowledged.add(eventId);
  }

  close(): void {
    this.#events.length = 0;
    this.#eventIds.clear();
    this.#acknowledged.clear();
  }

  #parseCursor(cursor: string): number {
    if (!/^(0|[1-9]\d*)$/.test(cursor)) throw new InvalidCursorError(cursor);
    const position = Number(cursor);
    if (!Number.isSafeInteger(position) || position > this.#events.length) {
      throw new InvalidCursorError(cursor);
    }
    return position;
  }

  #copy(event: FluidEvent): FluidEvent {
    return { ...event, payload: { ...event.payload } };
  }
}

/** In-memory only: restarting the process clears events and acknowledgements. */
export function createEventStore(): EventStore {
  return new EventStoreModule();
}
