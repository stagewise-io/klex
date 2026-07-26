import type { UIMessage } from 'ai';

import type { SessionInbox, SessionInboxEvent } from './inbox';
import type { AgentUITools } from './tools';

/**
 * Lifecycle status of a session, queryable by the router.
 *
 * - `active` — the session is alive and accepting input via its inbox.
 * - `terminated` — the session has shut itself down (e.g. fatal error).
 *   The inbox is closed; the router must not send new input.
 */
export type SessionStatus = 'active' | 'terminated';

/**
 * Information passed to {@link SessionHooks.onTerminated} when a session
 * shuts itself down (e.g. fatal error). The router uses this to create a
 * replacement session and optionally preserve history.
 */
export interface SessionTerminationInfo {
  sessionId: string;
  reason: string;
  finalMessages: ExtendedUIMessage[];
  /**
   * Inbox events that were pending (not yet consumed by a turn) when the
   * session terminated. The router should re-dispatch these to the
   * replacement session so the user does not lose input.
   */
  pendingEvents: SessionInboxEvent[];
  /**
   * Native messages that were pending in the inbox when the session
   * terminated. Re-dispatched alongside events.
   */
  pendingMessages: ExtendedUIMessage[];
}

/**
 * Hooks that the router registers on a session at creation time.
 * The session fires these callbacks at lifecycle transition points.
 * All types here depend only on types already in this file, so there is
 * no circular dependency with the router.
 */
export interface SessionHooks {
  /**
   * Called when a session self-terminates (e.g. fatal generation error).
   * NOT called during router-initiated graceful shutdown.
   */
  onTerminated?(info: SessionTerminationInfo): void;
}

/**
 * This is the interface that AgentSessions must implement in order to become
 * controllable by the Router.
 */
export interface AgentSession {
  inbox: SessionInbox;

  /**
   * Current lifecycle status. The router checks this before sending input
   * and may replace a terminated session.
   */
  readonly status: SessionStatus;

  /**
   * Start the session — spins up owned resources (e.g. the JavaScript
   * sandbox worker). Called by the router after creation. Idempotent.
   */
  start(): Promise<void>;

  /**
   * Gracefully shut down the session — ends the session trace span and
   * releases any resources. Called by the router during shutdown.
   *
   * After this call, `status` becomes `'terminated'`.
   */
  close(): Promise<void>;
}

/**
 * Extension to the metadata of UI messages for agents
 */
export type UIMessageMetadata = Record<string, never>;

/**
 * Custom data part that signals the model should continue its previous
 * generation (e.g. after truncation or a salvaged partial response).
 * The converter turns this into a text part with content "Continue.".
 */
export type ContinueDataUIPart = Record<string, never>;

/**
 * Custom data part that stores a history summary of the chat session. This is used to provide context to the agent about what has happened in the session so far.
 */
export type HistorySummaryDataUIPart = {
  /**
   * A summary of the things that happened
   */
  summary: string;
};

/**
 * Custom data part that stores context information for the agent. This is used to provide additional information from the outside world to the agent.
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

export type CustomUIDataParts = {
  'history-summary': HistorySummaryDataUIPart;
  context: ContextDataUIPart;
  continue: ContinueDataUIPart;
};

export type ExtendedUIMessage = UIMessage<
  UIMessageMetadata,
  CustomUIDataParts,
  AgentUITools
>;
