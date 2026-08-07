import { randomUUID } from 'node:crypto';

import type { ModuleLogger } from '@stagewise/logger';

import {
  getBase64DecodedBytes,
  type SessionInbox,
  SessionInboxClosedError,
  type SessionInboxEvent,
  SessionInboxUrgency,
} from '@/session/inbox';

import type { ExtendedUIMessage } from '../message-types';
import { tracer } from '../utils/tracing';

export type { SessionInbox, SessionInboxEvent };
// Re-export router-facing types for convenience — chat-internal consumers
// can import everything from one place.
export { SessionInboxClosedError, SessionInboxUrgency };

/**
 * Extends the router-facing {@link SessionInbox} with the ability to send
 * native messages directly into the session history. This is the interface
 * that chat-internal consumers (extensions, etc.) use.
 */
export interface ChatSessionInbox extends SessionInbox {
  /**
   * Send a native message into the inbox (advanced).
   *
   * Use this only when you need full control over the message structure
   * (e.g. custom data parts that are not context events). The message is
   * appended to the session history as-is — immediately for
   * Critical/Default urgency, or at the next turn start for Deferrable.
   *
   * @throws {SessionInboxClosedError} if the inbox has been closed.
   *
   * @param message The message to send into the inbox.
   * @param urgency The urgency with which the message is sent.
   */
  sendMessage: (
    message: ExtendedUIMessage,
    urgency: SessionInboxUrgency,
  ) => void;
}

export type DrainInboxResult = {
  total: number;
  deferredEvents: number;
  nativeMessages: number;
  before: { events: number; messages: number };
  remaining: { events: number; messages: number };
};

/**
 * Internal entry for a deferred native message in the inbox buffer.
 */
type DeferredMessageEntry = {
  message: ExtendedUIMessage;
};

/**
 * Internal interface for the session loop to drain events and messages from
 * the inbox. Extends {@link ChatSessionInbox} with read access.
 */
export interface SessionInboxBuffer extends ChatSessionInbox {
  /**
   * Drains deferred events and native messages from the inbox buffer,
   * appending them to the provided messages array.
   *
   * Native messages are appended first (in arrival order), followed by a
   * single user message bundling all context events as `data-context`
   * parts. If no events and no native messages are drained, the messages
   * array is left untouched.
   *
   * @param messages The session messages array to append drained content to.
   * @param logger Logger for recording the drain operation.
   * @returns Summary counts of drained events and native messages.
   */
  drain: (
    messages: ExtendedUIMessage[],
    logger: ModuleLogger,
  ) => DrainInboxResult;

  /**
   * Fetches all deferred context events and removes them from the inbox.
   *
   * Events are returned in ascending time order (oldest first).
   */
  getEvents: () => SessionInboxEvent[];

  /**
   * Fetches all deferred native messages and removes them from the inbox.
   *
   * Messages are returned in ascending time order (oldest first).
   */
  getMessages: () => ExtendedUIMessage[];

  /**
   * Returns if the box is empty (no deferred events and no deferred messages).
   */
  isEmpty: () => boolean;
}

export interface InboxDependencies {
  /**
   * Called for Critical and Default urgency events. The session appends
   * the event to the message history immediately. For Critical urgency,
   * the session also aborts the running generation.
   */
  onImmediateEvent: (event: SessionInboxEvent) => void;
  /**
   * Called for Critical and Default urgency native messages. The session
   * appends the message to the message history immediately. For Critical
   * urgency, the session also aborts the running generation.
   */
  onImmediateMessage: (
    message: ExtendedUIMessage,
    urgency: SessionInboxUrgency,
  ) => void;
  /**
   * Called for any input (any urgency). The session uses this to trigger
   * the loop, track new input during a turn, and interrupt backoff waits.
   */
  onNewInput: () => void;
  /** Optional logger for recording unexpected errors from the callback. */
  logger?: ModuleLogger;
}

/**
 * The inbox is a buffer for all external inputs to a session.
 * It holds two separate buffers for deferred items: one for context
 * events and one for native messages. Critical and Default urgency
 * items bypass the buffer via callbacks — they are appended to the
 * session history immediately on arrival.
 */
class InboxModule implements SessionInboxBuffer {
  // Sorted by age. Newer entries have higher index.
  // Only Deferrable urgency items are buffered here.
  private deferredEvents: SessionInboxEvent[] = [];

  private deferredMessages: DeferredMessageEntry[] = [];

  private closed = false;

  constructor(private readonly deps: InboxDependencies) {}

  send(event: SessionInboxEvent): void {
    if (this.closed) throw new SessionInboxClosedError();

    if (event.urgency === SessionInboxUrgency.Deferrable) {
      this.deferredEvents.push(event);
    } else {
      // Critical or Default — dispatch immediately via callback.
      this.notifyImmediateEvent(event);
    }

    this.notifyNewInput();
  }

  sendMessage(message: ExtendedUIMessage, urgency: SessionInboxUrgency): void {
    if (this.closed) throw new SessionInboxClosedError();

    if (urgency === SessionInboxUrgency.Deferrable) {
      this.deferredMessages.push({ message });
    } else {
      // Critical or Default — dispatch immediately via callback.
      this.notifyImmediateMessage(message, urgency);
    }

    this.notifyNewInput();
  }

  close(): void {
    this.closed = true;
  }

  private notifyImmediateEvent(event: SessionInboxEvent): void {
    try {
      this.deps.onImmediateEvent(event);
    } catch (err) {
      this.deps.logger?.error(
        { urgency: SessionInboxUrgency[event.urgency], err },
        'Inbox onImmediateEvent callback threw — event may not be in history',
      );
    }
  }

  private notifyImmediateMessage(
    message: ExtendedUIMessage,
    urgency: SessionInboxUrgency,
  ): void {
    try {
      this.deps.onImmediateMessage(message, urgency);
    } catch (err) {
      this.deps.logger?.error(
        { messageId: message.id, urgency: SessionInboxUrgency[urgency], err },
        'Inbox onImmediateMessage callback threw — message may not be in history',
      );
    }
  }

  private notifyNewInput(): void {
    try {
      this.deps.onNewInput();
    } catch (err) {
      this.deps.logger?.error({ err }, 'Inbox onNewInput callback threw');
    }
  }

  drain(messages: ExtendedUIMessage[], logger: ModuleLogger): DrainInboxResult {
    const beforeEvents = this.deferredEvents.length;
    const beforeMessages = this.deferredMessages.length;

    const span = tracer.startSpan('inbox.drain', {
      attributes: {
        'inbox.before.events': beforeEvents,
        'inbox.before.messages': beforeMessages,
      },
    });

    const events = this.getEvents();
    const nativeMessages = this.getMessages();

    // Record structure and media metadata without leaking binary bodies.
    // Telemetry projection must never prevent already-pulled inputs from being
    // appended to session history.
    try {
      const pulled = {
        events: events.map((e) => ({
          sourceEnv: e.sourceEnv,
          urgency: SessionInboxUrgency[e.urgency],
          context: redactMediaForTelemetry(e.context),
        })),
        nativeMessages: nativeMessages.map((m) => ({
          id: m.id,
          role: m.role,
          parts: redactMediaForTelemetry(m.parts),
        })),
      };
      span.setAttribute('inbox.drained.content', JSON.stringify(pulled));
    } catch {
      // Projection or serialization may fail for unusual custom data parts.
    }

    span.setAttributes({
      'inbox.drained.events': events.length,
      'inbox.drained.nativeMessages': nativeMessages.length,
      'inbox.drained.total': events.length + nativeMessages.length,
      'inbox.drained.deferredEvents': events.length,
      'inbox.remaining.events': this.deferredEvents.length,
      'inbox.remaining.messages': this.deferredMessages.length,
    });

    // Append native messages first, then bundle context events into a
    // single user message. This ensures native messages (which may carry
    // explicit user intent) appear before the aggregated context payload.
    for (const msg of nativeMessages) {
      messages.push(msg);
    }

    if (events.length > 0) {
      messages.push({
        role: 'user',
        id: randomUUID(),
        parts: events.map((e) => ({ type: 'data-context', data: e.context })),
      });
    }

    logger.debug(
      {
        total: events.length + nativeMessages.length,
        deferredEvents: events.length,
        nativeMessages: nativeMessages.length,
      },
      'Inbox drained',
    );

    span.end();

    return {
      total: events.length + nativeMessages.length,
      deferredEvents: events.length,
      nativeMessages: nativeMessages.length,
      before: { events: beforeEvents, messages: beforeMessages },
      remaining: {
        events: this.deferredEvents.length,
        messages: this.deferredMessages.length,
      },
    };
  }

  getEvents(): SessionInboxEvent[] {
    return this.deferredEvents.splice(0);
  }

  getMessages(): ExtendedUIMessage[] {
    return this.deferredMessages.splice(0).map((entry) => entry.message);
  }

  isEmpty(): boolean {
    return (
      this.deferredEvents.length === 0 && this.deferredMessages.length === 0
    );
  }
}

export function redactMediaForTelemetry(value: unknown): unknown {
  return redactMediaValue(value, new WeakSet<object>());
}

function redactMediaValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => redactMediaValue(entry, seen));
  }

  const record = value as Record<string, unknown>;
  const isInlineMedia =
    (record.type === 'image' || record.type === 'audio') &&
    typeof record.data === 'string';
  const isDataFile =
    record.type === 'file' &&
    typeof record.url === 'string' &&
    record.url.startsWith('data:');

  const projected = Object.fromEntries(
    Object.entries(record).map(([key, entry]) => {
      if (isInlineMedia && key === 'data') return [key, '[redacted]'];
      if (isDataFile && key === 'url') return [key, '[redacted]'];
      return [key, redactMediaValue(entry, seen)];
    }),
  );

  if (isInlineMedia) {
    projected.decodedBytes = getBase64DecodedBytes(record.data as string);
  } else if (isDataFile) {
    const url = record.url as string;
    const separator = url.indexOf(',');
    const encoded = separator === -1 ? '' : url.slice(separator + 1);
    projected.decodedBytes = getBase64DecodedBytes(encoded);
  }

  return projected;
}

export function createInbox(deps: InboxDependencies): SessionInboxBuffer {
  return new InboxModule(deps);
}
