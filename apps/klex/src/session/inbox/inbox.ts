/**
 * Inbox urgency levels controlling how events/messages are handled by
 * the session lifecycle.
 *
 * - **Critical**: Appended to history immediately and aborts the current
 *   generation. Use for urgent interrupts, user corrections.
 * - **Default**: Appended to history immediately but does not abort the
 *   current generation. The running step finishes naturally; the model
 *   sees the new input in the next step's clone or in a check-retry turn.
 * - **Deferrable**: Buffered until turn start drain. Background context
 *   that can wait. Not appended immediately, does not trigger check-retry.
 */
export enum SessionInboxUrgency {
  Critical = 0,
  Default = 1,
  Deferrable = 2,
}
export function getBase64DecodedBytes(data: string): number | undefined {
  if (data.length === 0 || data.length % 4 !== 0) return undefined;

  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  const contentLength = data.length - padding;
  for (let index = 0; index < contentLength; index++) {
    const code = data.charCodeAt(index);
    const valid =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47;
    if (!valid) return undefined;
  }

  if (padding > 0 && !/^={1,2}$/.test(data.slice(contentLength))) {
    return undefined;
  }
  return (data.length / 4) * 3 - padding;
}

/**
 * JSON value type for context metadata.
 */
export type ContextMetadataValue =
  | string
  | number
  | boolean
  | null
  | ContextMetadataValue[]
  | { [key: string]: ContextMetadataValue };

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
  metadata: Record<string, ContextMetadataValue>;

  /**
   * A record of key-value pairs that help describe the content to the agent.
   */
  content: (
    | { type: 'text'; text: string }
    | { type: 'image'; mimeType: string; data: string }
    | { type: 'audio'; mimeType: string; data: string }
    | {
        type: 'resource_link';
        uri: string;
        name: string;
        title?: string;
        description?: string;
        mimeType?: string;
        size?: number;
      }
    | {
        type: 'resource';
        resource: {
          uri: string;
          mimeType?: string;
          text?: string;
          blob?: string;
        };
      }
  )[];
};

export type SessionInboxEvent = {
  sourceEnv: string;
  urgency: SessionInboxUrgency;
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
   * @param event.urgency The urgency of the input. Critical aborts the current generation and appends immediately. Default appends immediately without aborting. Deferrable buffers until the next turn start.
   * @param event.context The context item that should be sent to the model.
   */
  send: (event: SessionInboxEvent) => void;

  /**
   * Closes the inbox — no further events can be added.
   * Attempts to send after closing throw {@link SessionInboxClosedError}.
   */
  close: () => void;
}
