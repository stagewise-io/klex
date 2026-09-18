import type { ModelPurpose } from '@/config';
import type { IntrospectionScope } from '@/introspection';
import type { Mcp } from '@/mcp';

import type { ExtensionFactory } from './chat/extensions/extension-api';
import type { ChatSessionInbox } from './chat/inbox';
import type { ExtendedUIMessage } from './chat/message-types';
import type { SessionInboxEvent } from './inbox';
import type { ConversationHost } from './interaction';

/** Stable identifier assigned to the default session. */
export const DEFAULT_SESSION_ID = 'default';

/**
 * Lifecycle status of a session, queryable by its owner.
 *
 * - `active` — the session is alive and accepting input via its inbox.
 * - `terminated` — the session has shut itself down (e.g. fatal error).
 *   The inbox is closed; the owner must not send new input.
 */
export type SessionStatus = 'active' | 'terminated';

/**
 * Fine-grained runtime state of a session, queryable for observability.
 *
 * - `working` — a turn is currently executing (generation in progress).
 * - `retrying` — all models failed; waiting in exponential backoff before retry.
 * - `success` — the most recent turn completed successfully.
 * - `idle` — inbox is empty; no turn is active.
 * - `leased` — the generation lane is held by another interaction mode
 *   (e.g. an active realtime call); chat generation is suspended.
 * - `terminated` — the session has shut down (fatal error or graceful close).
 */
export type SessionRuntimeState =
  | 'working'
  | 'retrying'
  | 'success'
  | 'idle'
  | 'leased'
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
  /** Unique session identifier. The default session uses `default`. */
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
 * shuts itself down (e.g. fatal error). The owner uses this to create a
 * replacement session and re-dispatch pending inbox events.
 */
export interface SessionTerminationInfo {
  sessionId: string;
  reason: string;
  /**
   * Inbox events that were pending (not yet consumed by a turn) when the
   * session terminated. The owner re-dispatches these to the replacement
   * session so the user does not lose input.
   */
  pendingEvents: SessionInboxEvent[];
}

/**
 * Hooks that the owner registers on a session at creation time.
 * The session fires these callbacks at lifecycle transition points.
 * All types here depend only on types already in this file, so there is
 * no circular dependency with the owner.
 */
export interface SessionHooks {
  /**
   * Called when a session self-terminates (e.g. fatal generation error).
   * NOT called during owner-initiated graceful shutdown.
   */
  onTerminated?(info: SessionTerminationInfo): void | Promise<void>;
}

/**
 * Extended {@link AgentSession} handle that exposes chat-specific capabilities.
 *
 * Owners interact with sessions through the narrow {@link AgentSession}
 * interface. Modules that need to send native messages (e.g. the god-messages
 * module) use this wider handle to access {@link ChatSessionInbox.sendMessage}
 * and the session ID.
 */
export interface ChatSessionHandle extends AgentSession {
  /** Inbox with `sendMessage` for injecting native messages. */
  inbox: ChatSessionInbox;
  /** Unique session identifier (UUID). */
  readonly sessionId: string;
  /** Snapshot of the session's message history (shallow copy). */
  getMessages(): readonly ExtendedUIMessage[];
  /** Creates and fully starts an isolated child session. */
  createChildSession(options: ChildSessionOptions): Promise<ChildSessionHandle>;
  /** Waits until the session reaches its idle boundary or the timeout expires. */
  waitForIdle(timeoutMs: number): Promise<boolean>;
}

/**
 * This is the interface that AgentSessions must implement in order to become
 * controllable by their owner.
 *
 * Every session is a {@link ConversationHost}: the owner delegates
 * interaction-lease acquisition to the current default session.
 */
export interface AgentSession extends ConversationHost {
  /**
   * Current lifecycle status. The owner checks this before acquiring a lease
   * and may replace a terminated session.
   */
  readonly status: SessionStatus;

  /**
   * Start the session — spins up owned resources (e.g. the JavaScript
   * sandbox worker). Called by the owner after creation. Idempotent.
   */
  start(): Promise<void>;

  /**
   * Gracefully shut down the session — ends the session trace span and
   * releases any resources. Called by the owner during shutdown.
   *
   * After this call, `status` becomes `'terminated'`.
   */
  close(): Promise<void>;

  /**
   * Re-dispatch pending inbox events into this session. Called by the
   * owner when replacing a terminated session — the events that were
   * pending in the old session are forwarded so the user does not lose
   * input.
   */
  restorePendingEvents(events: SessionInboxEvent[]): void;

  /**
   * Snapshot of the session's current state for observability.
   * Used by the owner to aggregate session info in the introspection tree.
   */
  getSessionInfo(): SessionInfo;
}

// ---------------------------------------------------------------------------
// Session kinds and context
// ---------------------------------------------------------------------------

/**
 * The kind of session, determining its isolation level and capabilities.
 *
 * - `default` — the main execution unit. Has MCP access, subscribes to
 *   push notifications, and receives outside input.
 * - `god` — an isolated session for god messages. No MCP, no push
 *   notifications. Input comes only from the god-messages module.
 * - `child` — a session spawned by an extension. No MCP, no push
 *   notifications. Input comes only from the parent extension.
 */
export type SessionKind = 'default' | 'god' | 'child';

/**
 * Context describing the session's identity and position in the session tree.
 * Extensions inspect this to decide session-specific behavior.
 */
export interface SessionContext {
  kind: SessionKind;
  sessionId: string;
  /** Parent session ID (child sessions only). */
  parentId?: string;
}

/**
 * Options for creating a child session.
 */
export interface ChildSessionOptions {
  extensions: ExtensionFactory[];
  /** Configured model list this child session uses. Defaults to `chat`. */
  modelPurpose?: ModelPurpose;
  /**
   * Base system prompt for the child session. Every child session must
   * explicitly declare its base prompt. Pass an empty string to suppress
   * the base prompt entirely (e.g. for a session that should only use
   * extension-contributed system prompt parts).
   */
  basePrompt: string;
}

/**
 * Handle to a child session, owned by the extension that spawned it.
 */
export interface ChildSessionHandle {
  readonly sessionId: string;
  inbox: ChatSessionInbox;
  getMessages(): readonly ExtendedUIMessage[];
  getSessionInfo(): SessionInfo;
  close(): Promise<void>;
  /** Waits until the child reaches its idle boundary or the timeout expires. */
  waitForIdle(timeoutMs: number): Promise<boolean>;
  /** Creates and fully starts an isolated grandchild session. */
  createChildSession(options: ChildSessionOptions): Promise<ChildSessionHandle>;
}

/**
 * Per-session parameters passed to a {@link SessionFactory} when creating a
 * session. Shared deps (logging, config, modelResolver, dataDirectory) are
 * captured by the factory closure itself.
 */
export interface SessionFactoryParams {
  mcp: Mcp | null;
  sessionContext: SessionContext;
  extensionFactories: ExtensionFactory[];
  introspectionScope: IntrospectionScope;
  hooks?: SessionHooks;
  /** Configured model list this session uses. Defaults to `chat`. */
  modelPurpose?: ModelPurpose;
  /** Base system prompt for this session. */
  basePrompt: string;
}

/**
 * Factory that creates a {@link ChatSessionHandle} from per-session parameters.
 * The composition root creates one closure that captures shared deps; callers
 * supply only session-specific options.
 */
export type SessionFactory = (
  params: SessionFactoryParams,
) => ChatSessionHandle;
