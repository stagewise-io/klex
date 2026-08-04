import { randomUUID } from 'node:crypto';

import type { ModuleLogger } from '@stagewise/logger';

import {
  getBase64DecodedBytes,
  type SessionInbox,
  SessionInboxClosedError,
  type SessionInboxEvent,
  SessionInboxPriority,
} from '@/session/inbox';
import { tracer } from '@/tracing';

import type { ExtendedUIMessage } from '../message-types';

export type { SessionInbox, SessionInboxEvent };
// Re-export router-facing types for convenience — chat-internal consumers
// can import everything from one place.
export { SessionInboxClosedError, SessionInboxPriority };

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
   * appended to the session history as-is during inbox draining.
   *
   * @throws {SessionInboxClosedError} if the inbox has been closed.
   *
   * @param message The message to send into the inbox.
   * @param priority The priority with which the message is sent.
   */
  sendMessage: (
    message: ExtendedUIMessage,
    priority: SessionInboxPriority,
  ) => void;
}

export type DrainInboxResult = {
  total: number;
  byPriority: { low: number; medium: number; high: number };
  nativeMessages: number;
  before: { events: number; messages: number };
  remaining: { events: number; messages: number };
};

/**
 * Internal entry for a native message in the inbox buffer.
 */
type InboxMessageEntry = {
  priority: SessionInboxPriority;
  message: ExtendedUIMessage;
};

/**
 * Internal interface for the session loop to drain events and messages from
 * the inbox. Extends {@link ChatSessionInbox} with read access.
 */
export interface SessionInboxBuffer extends ChatSessionInbox {
  /**
   * Drains events and native messages at or above the given minimum
   * priority, appending them to the provided messages array.
   *
   * Native messages are appended first (in arrival order), followed by a
   * single user message bundling all context events as `data-context`
   * parts. If no events and no native messages are drained, the messages
   * array is left untouched.
   *
   * @param messages The session messages array to append drained content to.
   * @param minPriority The minimum priority to drain.
   * @param logger Logger for recording the drain operation.
   * @returns Summary counts of drained events and native messages.
   */
  drain: (
    messages: ExtendedUIMessage[],
    minPriority: SessionInboxPriority,
    logger: ModuleLogger,
  ) => DrainInboxResult;

  /**
   * Fetches context events with the given minimum priority and removes them
   * from the inbox.
   *
   * Events are returned in ascending time order (oldest first).
   *
   * @param minPriority The minimum priority of the events to fetch.
   */
  getEvents: (minPriority: SessionInboxPriority) => SessionInboxEvent[];

  /**
   * Fetches native messages with the given minimum priority and removes them
   * from the inbox.
   *
   * Messages are returned in ascending time order (oldest first).
   *
   * @param minPriority The minimum priority of the messages to fetch.
   */
  getMessages: (minPriority: SessionInboxPriority) => ExtendedUIMessage[];

  /**
   * Returns if the box is empty (no events and no messages).
   */
  isEmpty: () => boolean;
}

export interface InboxDependencies {
  /** Called whenever a new event or message is pushed into the inbox. */
  onNewEvent: (priority: SessionInboxPriority) => void;
  /** Optional logger for recording unexpected errors from the callback. */
  logger?: ModuleLogger;
}

/**
 * The inbox is a buffer for all external inputs to a session.
 * It holds two separate buffers: one for context events and one for
 * native messages.
 */
class InboxModule implements SessionInboxBuffer {
  // Sorted by age. Newer entries have higher index.
  private events: SessionInboxEvent[] = [];

  private messages: InboxMessageEntry[] = [];

  private closed = false;

  constructor(private readonly deps: InboxDependencies) {}

  send(event: SessionInboxEvent): void {
    if (this.closed) throw new SessionInboxClosedError();
    this.events.push(event);
    this.notifyNewEvent(event.priority ?? SessionInboxPriority.Medium);
  }

  sendMessage(
    message: ExtendedUIMessage,
    priority: SessionInboxPriority,
  ): void {
    if (this.closed) throw new SessionInboxClosedError();
    this.messages.push({ priority, message });
    this.notifyNewEvent(priority);
  }

  close(): void {
    this.closed = true;
  }

  /**
   * Notifies the session that new input arrived. The event/message is
   * already buffered at this point, so a throwing callback must not
   * reject the sender — the loop will drain the buffer on its next
   * iteration regardless.
   */
  private notifyNewEvent(priority: SessionInboxPriority): void {
    try {
      this.deps.onNewEvent(priority);
    } catch (err) {
      this.deps.logger?.error(
        { priority: SessionInboxPriority[priority], err },
        'Inbox onNewEvent callback threw — event is buffered, will be drained on next loop iteration',
      );
    }
  }

  drain(
    messages: ExtendedUIMessage[],
    minPriority: SessionInboxPriority,
    logger: ModuleLogger,
  ): DrainInboxResult {
    const beforeEvents = this.events.length;
    const beforeMessages = this.messages.length;

    const span = tracer.startSpan('inbox.drain', {
      attributes: {
        'inbox.minPriority': SessionInboxPriority[minPriority],
        'inbox.before.events': beforeEvents,
        'inbox.before.messages': beforeMessages,
      },
    });

    const events = this.getEvents(minPriority);
    const nativeMessages = this.getMessages(minPriority);

    const byPriority: { low: number; medium: number; high: number } = {
      low: 0,
      medium: 0,
      high: 0,
    };
    for (const e of events) {
      const p = e.priority ?? SessionInboxPriority.Medium;
      if (p === SessionInboxPriority.Low) byPriority.low++;
      else if (p === SessionInboxPriority.Medium) byPriority.medium++;
      else if (p === SessionInboxPriority.High) byPriority.high++;
    }

    // Record structure and media metadata without leaking binary bodies.
    // Telemetry projection must never prevent already-pulled inputs from being
    // appended to session history.
    try {
      const pulled = {
        events: events.map((e) => ({
          sourceEnv: e.sourceEnv,
          priority:
            SessionInboxPriority[e.priority ?? SessionInboxPriority.Medium],
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
      'inbox.drained.low': byPriority.low,
      'inbox.drained.medium': byPriority.medium,
      'inbox.drained.high': byPriority.high,
      'inbox.remaining.events': this.events.length,
      'inbox.remaining.messages': this.messages.length,
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
        minPriority: SessionInboxPriority[minPriority],
        total: events.length + nativeMessages.length,
        low: byPriority.low,
        medium: byPriority.medium,
        high: byPriority.high,
        nativeMessages: nativeMessages.length,
      },
      'Inbox drained',
    );

    span.end();

    return {
      total: events.length + nativeMessages.length,
      byPriority,
      nativeMessages: nativeMessages.length,
      before: { events: beforeEvents, messages: beforeMessages },
      remaining: {
        events: this.events.length,
        messages: this.messages.length,
      },
    };
  }

  getEvents(minPriority: SessionInboxPriority): SessionInboxEvent[] {
    const [matching, notMatching] = this.events.reduce<
      [SessionInboxEvent[], SessionInboxEvent[]]
    >(
      (prev, curr) => {
        const matches =
          (curr.priority ?? SessionInboxPriority.Medium) >= minPriority;
        prev[matches ? 0 : 1].push(curr);
        return prev;
      },
      [[], []],
    );

    this.events = notMatching;
    return matching;
  }

  getMessages(minPriority: SessionInboxPriority): ExtendedUIMessage[] {
    const [matching, notMatching] = this.messages.reduce<
      [InboxMessageEntry[], InboxMessageEntry[]]
    >(
      (prev, curr) => {
        prev[curr.priority >= minPriority ? 0 : 1].push(curr);
        return prev;
      },
      [[], []],
    );

    this.messages = notMatching;
    return matching.map((entry) => entry.message);
  }

  isEmpty(): boolean {
    return this.events.length === 0 && this.messages.length === 0;
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
