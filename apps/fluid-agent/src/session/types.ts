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
 * Fine-grained runtime state of a session, queryable for observability.
 *
 * - `working` — a turn is currently executing (generation in progress).
 * - `retrying` — all models failed; waiting in exponential backoff before retry.
 * - `success` — the most recent turn completed successfully.
 * - `idle` — inbox is empty; no turn is active.
 * - `terminated` — the session has shut down (fatal error or graceful close).
 */
export type SessionRuntimeState =
  | 'working'
  | 'retrying'
  | 'success'
  | 'idle'
  | 'terminated';

/** Active model information for a session. */
export interface SessionModelInfo {
  /** The model ID currently in use (may be a fallback model). */
  id: string;
  /** True when the session is on a fallback model (fallbackIndex > 0). */
  isFallback: boolean;
  /** Current fallback index (0 = default model). */
  fallbackIndex: number;
}

/** Token usage for a single generation or cumulative across a session. */
export interface SessionTokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Aggregated session information exposed for observability. */
export interface SessionInfo {
  /** Unique session identifier (UUID). */
  id: string;
  /** Coarse lifecycle status. */
  status: SessionStatus;
  /** Fine-grained runtime state. */
  runtimeState: SessionRuntimeState;
  /** Currently active model and fallback state. */
  model: SessionModelInfo;
  /** Token consumption (latest generation + cumulative total). */
  tokens: {
    latest: SessionTokenUsage | null;
    total: SessionTokenUsage;
  };
  /** Total number of turns completed. */
  turns: number;
  /** Total number of steps executed across all turns. */
  steps: number;
  /** Number of messages in the session history. */
  messageCount: number;
  /** ISO timestamp of session creation. */
  createdAt: string;
}

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
   * Returns aggregated observability information for this session.
   * Includes runtime state, active model, token consumption, and
   * turn/step counts.
   */
  getSessionInfo(): SessionInfo;

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
export type ContextSummaryDataUIPart = {
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
  'context-summary': ContextSummaryDataUIPart;
  context: ContextDataUIPart;
  continue: ContinueDataUIPart;
};

export type ExtendedUIMessage = UIMessage<
  UIMessageMetadata,
  CustomUIDataParts,
  AgentUITools
>;
