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

/**
 * Custom data part that stores context information for the agent. This is used
 * to provide additional information from the outside world to the agent.
 */
export type ContextDataUIPart = {
  /**
   * The source environment this input is coming from
   */
  sourceEnv: string;

  /**
   * A record of key-value pairs that help describe the content to the agent.
   */
  metadata: {
    [key: string]: string | number | boolean;
  };

  /**
   * A record of key-value pairs that help describe the content to the agent.
   */
  content: (
    | { type: 'text'; text: string }
    | { type: 'image'; mimeType: string; url: string }
    | { type: 'video'; mimeType: string; url: string }
    | { type: 'audio'; mimeType: string; url: string }
  )[];
};

export type SessionInboxEvent = {
  sourceEnv: string;
  priority: SessionInboxPriority;
  context: ContextDataUIPart;
};

/**
 * Thrown when {@link SessionInbox.send} is called on an inbox whose session
 * has been closed.
 */
export class SessionInboxClosedError extends Error {
  constructor() {
    super('Session inbox is closed — the session has been shut down.');
    this.name = 'SessionInboxClosedError';
    Object.setPrototypeOf(this, SessionInboxClosedError.prototype);
  }
}

/**
 * The session inbox offers a way to send input into an agent.
 *
 * This is the narrow, router-facing interface exposed to environments
 * (MCP servers, etc.) and to the router itself. It deliberately carries
 * no AI SDK types.
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
   * Closes the inbox — no further events can be added.
   * Attempts to send after closing throw {@link SessionInboxClosedError}.
   */
  close: () => void;
}
