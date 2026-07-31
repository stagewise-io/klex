import { randomUUID } from 'node:crypto';

import type {
  GetEventsResult,
  PushNotification,
  PushNotificationNotificationParams,
} from '@stagewise/mcp-extension-push-notifications';

export const MAX_MESSAGE_LENGTH = 4_000;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1_000;

export interface ChatMessage {
  id: string;
  sender: 'user' | 'agent';
  message: string;
  createdAt: string;
}

export interface UserMessageResult {
  message: ChatMessage;
  notification: PushNotificationNotificationParams;
}

export interface ChatStore {
  listMessages(): ChatMessage[];
  addUserMessage(input: string): UserMessageResult;
  addAgentMessage(input: string): ChatMessage;
  getEvents(options?: { limit?: number }): GetEventsResult;
  acknowledgeEvents(eventIds: string[]): void;
  subscribe(listener: (message: ChatMessage) => void): () => void;
  close(): void;
}

export class InvalidMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMessageError';
  }
}

class ChatStoreModule implements ChatStore {
  readonly #messages: ChatMessage[] = [];
  readonly #events: PushNotification[] = [];
  readonly #acknowledged = new Set<string>();
  readonly #listeners = new Set<(message: ChatMessage) => void>();

  listMessages(): ChatMessage[] {
    return this.#messages.map((message) => ({ ...message }));
  }

  addUserMessage(input: string): UserMessageResult {
    const message = this.#createMessage('user', input);
    const event: PushNotification = {
      eventId: randomUUID(),
      sourceId: 'chat-simulator:local',
      type: 'chat.message.received',
      createdAt: message.createdAt,
      payload: { messageId: message.id, message: message.message },
    };
    this.#messages.push(message);
    this.#events.push(event);
    this.#emit(message);
    return {
      message: { ...message },
      notification: {
        event: { ...event },
      },
    };
  }

  addAgentMessage(input: string): ChatMessage {
    const message = this.#createMessage('agent', input);
    this.#messages.push(message);
    this.#emit(message);
    return { ...message };
  }

  getEvents(options: { limit?: number } = {}): GetEventsResult {
    const limit = Math.min(options.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const pending = this.#events.filter(
      (event) => !this.#acknowledged.has(event.eventId),
    );
    return {
      events: pending
        .slice(0, limit)
        .map((event) => ({ ...event, payload: { ...event.payload } })),
      hasMore: pending.length > limit,
    };
  }

  acknowledgeEvents(eventIds: string[]): void {
    for (const eventId of eventIds) this.#acknowledged.add(eventId);
  }

  subscribe(listener: (message: ChatMessage) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close(): void {
    this.#listeners.clear();
  }

  #createMessage(sender: ChatMessage['sender'], input: string): ChatMessage {
    const message = input.trim();
    if (message.length === 0) throw new InvalidMessageError('Message is empty');
    if (message.length > MAX_MESSAGE_LENGTH) {
      throw new InvalidMessageError(
        `Message exceeds ${MAX_MESSAGE_LENGTH} characters`,
      );
    }
    return {
      id: randomUUID(),
      sender,
      message,
      createdAt: new Date().toISOString(),
    };
  }

  #emit(message: ChatMessage): void {
    for (const listener of this.#listeners) listener({ ...message });
  }
}

export function createChatStore(): ChatStore {
  return new ChatStoreModule();
}
