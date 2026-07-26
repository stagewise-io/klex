import { randomUUID } from 'node:crypto';

import type { ModuleLogger } from '@stagewise/logger';

import type { ContextDataUIPart, ExtendedUIMessage } from '@/session/types';

import { tracer } from '../chat/utils/tracing';

/**
 * Inbox priority levels controlling when buffered events/messages are
 * consumed by the session lifecycle.
 *
 * - **Low**: Consumed at turn start only. Background context, non-urgent
 *   information. Not consumed mid-turn.
 * - **Medium**: Consumed per-step at step start. Normal user input, tool
 *   results. Picks up events that arrive mid-turn.
 * - **High**: Aborts the current generation immediately and is consumed
 *   by the next step. Urgent interrupts, user corrections.
 *
 * The Turn drains at `Low` (which includes Medium+High via `>= minPriority`),
 * and the Step drains at `Medium` (which includes High). This means all
 * events are consumed at turn start, and Medium+High events are re-checked
 * at each step start for mid-turn arrivals.
 */
export enum SessionInboxPriority {
  Low = 0,
  Medium = 1,
  High = 2,
}

export type SessionInboxEvent = {
  sourceEnv: string;
  priority: SessionInboxPriority;
  context: ContextDataUIPart;
};

/**
 * Thrown when {@link SessionInbox.send} or {@link SessionInbox.sendMessage}
 * is called on an inbox whose session has been closed.
 */
export class SessionInboxClosedError extends Error {
  constructor() {
    super('Session inbox is closed — the session has been shut down.');
    this.name = 'SessionInboxClosedError';
    Object.setPrototypeOf(this, SessionInboxClosedError.prototype);
  }
}

/**
 * Internal entry for a native message in the inbox buffer.
 */
type InboxMessageEntry = {
  priority: SessionInboxPriority;
  message: ExtendedUIMessage;
};

export type DrainInboxResult = {
  total: number;
  byPriority: { low: number; medium: number; high: number };
  nativeMessages: number;
  before: { events: number; messages: number };
  remaining: { events: number; messages: number };
};

/**
 * The session inbox offers a way to send input into an agent.
 *
 * This is the narrow interface exposed to environments (MCP servers, etc.)
 * and to extensions.
 */
export interface SessionInbox {
  /**
   * Send a context event into the inbox (recommended).
   *
   * Context events are the standard way to feed information into the agent.
   * They get wrapped into a user message with `data-context` parts during
   * inbox draining.
   *
   * @throws {SessionInboxClosedError} if the inbox has been closed.
   *
   * @param event.sourceEnv The environment from which the input originates.
   * @param event.priority The priority with which the input is sent. Higher priority gets faster response.
   * @param event.context The context item that should be sent to the model.
   */
  send: (event: SessionInboxEvent) => void;

  /**
   * Send a native `ExtendedUIMessage` into the inbox (advanced).
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

  /**
   * Closes the inbox — no further events or messages can be added.
   * Attempts to send after closing throw {@link SessionInboxClosedError}.
   */
  close: () => void;
}

/**
 * Internal interface for the session loop to drain events and messages from
 * the inbox. Extends {@link SessionInbox} with read access.
 */
export interface SessionInboxBuffer extends SessionInbox {
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
    this.notifyNewEvent(event.priority);
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
      if (e.priority === SessionInboxPriority.Low) byPriority.low++;
      else if (e.priority === SessionInboxPriority.Medium) byPriority.medium++;
      else if (e.priority === SessionInboxPriority.High) byPriority.high++;
    }

    // Record what was pulled from the inbox (including full content).
    const pulled = {
      events: events.map((e) => ({
        sourceEnv: e.sourceEnv,
        priority: SessionInboxPriority[e.priority],
        context: e.context,
      })),
      nativeMessages: nativeMessages.map((m) => ({
        id: m.id,
        role: m.role,
        parts: m.parts,
      })),
    };
    try {
      span.setAttribute('inbox.drained.content', JSON.stringify(pulled));
    } catch {
      // Serialization may fail for circular structures — skip silently.
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
        total: events.length,
        low: byPriority.low,
        medium: byPriority.medium,
        high: byPriority.high,
        nativeMessages: nativeMessages.length,
      },
      'Inbox drained',
    );

    span.end();

    return {
      total: events.length,
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
        prev[curr.priority >= minPriority ? 0 : 1].push(curr);
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

export function createInbox(deps: InboxDependencies): SessionInboxBuffer {
  return new InboxModule(deps);
}
