import type { SessionInboxEvent } from './inbox';

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
  id: string | null;
  /** True when the session is on a fallback model (fallbackIndex > 0). */
  isFallback: boolean;
  /** Current fallback index (0 = default model). */
  fallbackIndex: number;
}

/**
 * Token usage with cache breakdown. Used for both per-generation (latest)
 * and cumulative (total) usage tracking.
 */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  inputCacheWriteTokens: number;
  inputCacheReadTokens: number;
}

/** A latest + total usage pair. */
export interface UsagePair {
  latest: Usage | null;
  total: Usage;
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
  /** Token usage broken down by chat generations and per-extension calls. */
  usage: {
    chat: UsagePair;
    extensions: Record<string, UsagePair>;
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
 * replacement session and re-dispatch pending inbox events.
 */
export interface SessionTerminationInfo {
  sessionId: string;
  reason: string;
  /**
   * Inbox events that were pending (not yet consumed by a turn) when the
   * session terminated. The router re-dispatches these to the replacement
   * session so the user does not lose input.
   */
  pendingEvents: SessionInboxEvent[];
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
  onTerminated?(info: SessionTerminationInfo): void | Promise<void>;
}

/**
 * This is the interface that AgentSessions must implement in order to become
 * controllable by the Router.
 */
export interface AgentSession {
  inbox: {
    send(event: SessionInboxEvent): void;
    close(): void;
  };
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

  /**
   * Re-dispatch pending inbox events into this session. Called by the
   * router when replacing a terminated session — the events that were
   * pending in the old session are forwarded so the user does not lose
   * input.
   */
  restorePendingEvents(events: SessionInboxEvent[]): void;
}
