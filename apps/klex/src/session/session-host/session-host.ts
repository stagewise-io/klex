import type { ModuleLogger, RootLogger } from '@stagewise/logger';

import type { RuntimeResource } from '@/composition/runtime';
import type { IntrospectionScope } from '@/introspection';
import type { Mcp } from '@/mcp';
import type { SessionInboxEvent } from '@/session/inbox';
import type {
  InteractionLease,
  InteractionLeaseRequest,
} from '@/session/interaction';
import {
  type AgentSession,
  DEFAULT_SESSION_ID,
  type SessionContext,
  type SessionFactory,
  type SessionHooks,
  type SessionTerminationInfo,
} from '@/session/types';

export { DEFAULT_SESSION_ID } from '@/session/types';

export interface SessionHostDependencies {
  logging: RootLogger;
  mcp: Mcp;
  introspection: IntrospectionScope;
  sessionFactory: SessionFactory;
  basePrompt: string;
}

/** Thrown when a lease is requested while the session host is not running. */
class SessionHostUnavailableError extends Error {
  constructor() {
    super('Session host is not running — cannot acquire an interaction lease');
    this.name = 'SessionHostUnavailableError';
  }
}

/** Thrown when a lease is requested while the host drains for a restart. */
export class SessionHostDrainingError extends Error {
  constructor() {
    super(
      'Session host is draining for a restart — cannot acquire an interaction lease',
    );
    this.name = 'SessionHostDrainingError';
  }
}

/** Interval at which delivered push notifications are acknowledged once the agent is quiescent. */
const ACK_FLUSH_INTERVAL_MS = 1_000;

export interface SessionHost extends RuntimeResource {
  acquireInteractionLease(
    request: InteractionLeaseRequest,
  ): Promise<InteractionLease>;

  /**
   * True when the host is running, holds no undelivered events, and the
   * default session and all of its live child sessions are idle. Every
   * push notification delivered before a quiescent check has therefore
   * been handled by a finished turn.
   */
  isQuiescent(): boolean;

  /** True while a realtime call owns the default session's generation lane. */
  isInteractionLeased(): boolean;

  /**
   * Enters drain mode before a restart. New interaction leases are
   * rejected with {@link SessionHostDrainingError}; existing leases and
   * running turns continue. Irreversible: a restart always follows.
   */
  beginDrain(): void;
}

class SessionHostModule implements SessionHost {
  private _session: AgentSession | null = null;
  private started = false;
  private draining = false;
  private ackFlushTimer: ReturnType<typeof setInterval> | null = null;
  private ackFlushInFlight: Promise<void> | null = null;
  private sessionsScope: IntrospectionScope | null = null;

  /** Events retained until an active replacement accepts them. */
  private pendingEvents: SessionInboxEvent[] = [];

  /**
   * Serializes every mutation of the session (creation, replacement)
   * against readers that must not observe a stale session — most notably
   * lease acquisition. Held only while the session is being resolved,
   * never while a lease handshake is in flight.
   */
  private sessionMutation: Promise<unknown> = Promise.resolve();

  /** Serializes start, shutdown, and lease handshakes. */
  private lifecycleMutation: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly deps: {
      logger: ModuleLogger;
      mcp: Mcp;
      introspection: IntrospectionScope;
      sessionFactory: SessionFactory;
      basePrompt: string;
    },
  ) {}

  start(): Promise<void> {
    return this.withLifecycleLock(() => this.startUnlocked());
  }

  private async startUnlocked(): Promise<void> {
    if (this.started) return;

    this.sessionsScope = this.deps.introspection.child('sessions');
    this.sessionsScope.introspect(() => ({
      sessions:
        this._session && this._session.status === 'active'
          ? [this._session.getSessionInfo()]
          : [],
    }));

    try {
      this._session = await this.withSessionLock(() => this.createSession());
      this.started = true;
      this.startAckFlushPoller();
      this.deps.logger.info('Session host started');
    } catch (error) {
      this.deps.introspection.removeChild('sessions');
      this.sessionsScope = null;
      this.deps.logger.error(
        { error },
        'Default session startup failed; session host cannot start',
      );
      throw error;
    }
  }

  close(): Promise<void> {
    return this.withLifecycleLock(() => this.closeUnlocked());
  }

  private async closeUnlocked(): Promise<void> {
    if (!this.started) return;
    this.stopAckFlushPoller();
    // Cleared first so a concurrent lease acquisition is rejected instead of
    // handshaking with a session that is about to close.
    this.started = false;

    // The lock drains any in-flight session creation so shutdown cannot race
    // a replacement into existence after the host stopped.
    await this.withSessionLock(async () => {
      if (this._session) {
        await this._session.close();
        this.deps.logger.info('Session host closed session');
      }
      this._session = null;
    });

    this.deps.introspection.removeChild('sessions');
    this.sessionsScope = null;
    this.deps.logger.info('Session host stopped');
  }

  acquireInteractionLease(
    request: InteractionLeaseRequest,
  ): Promise<InteractionLease> {
    return this.withLifecycleLock(() =>
      this.acquireInteractionLeaseUnlocked(request),
    );
  }

  private async acquireInteractionLeaseUnlocked(
    request: InteractionLeaseRequest,
  ): Promise<InteractionLease> {
    if (!this.started) throw new SessionHostUnavailableError();
    if (this.draining) throw new SessionHostDrainingError();

    // Resolving the session is serialized against replacement, so the
    // handshake below never starts against a session the host has already
    // discarded. The handshake itself runs outside the lock: it can wait
    // for the chat loop to reach a safe boundary, and blocking replacement
    // for that long would deadlock termination handling.
    const session = await this.resolveDefaultSession();
    const lease = await session.acquireInteractionLease(request);

    this.deps.logger.info(
      {
        leaseId: lease.id,
        sessionId: lease.sessionId,
        mode: request.mode,
        namespace: request.namespace,
      },
      'Session host granted interaction lease on the default session',
    );
    return lease;
  }

  isQuiescent(): boolean {
    // A missing or terminated default session may have been interrupted
    // mid-turn; its delivered events must not be ACKed until a live
    // replacement exists.
    const session = this._session;
    return (
      this.started &&
      this.pendingEvents.length === 0 &&
      session !== null &&
      session.status !== 'terminated' &&
      session.isQuiescent()
    );
  }

  isInteractionLeased(): boolean {
    return this._session?.getSessionInfo().runtimeState === 'leased';
  }

  beginDrain(): void {
    if (this.draining) return;
    this.draining = true;
    this.deps.logger.info(
      'Session host draining: new interaction leases are rejected',
    );
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Acknowledges delivered push notifications once the agent is quiescent.
   * The quiescence check and MCP's snapshot of delivered IDs run in the
   * same synchronous tick, so no event delivered after the check can be
   * acknowledged before it was handled.
   */
  private startAckFlushPoller(): void {
    this.ackFlushTimer = setInterval(() => {
      if (this.ackFlushInFlight) return;
      if (!this.deps.mcp.hasUnacknowledgedEvents()) return;
      if (!this.isQuiescent()) return;
      this.ackFlushInFlight = this.deps.mcp
        .acknowledgeDeliveredEvents()
        .catch((error: unknown) => {
          this.deps.logger.warn(
            { error },
            'Acknowledging delivered push notifications failed; retrying on next flush',
          );
        })
        .finally(() => {
          this.ackFlushInFlight = null;
        });
    }, ACK_FLUSH_INTERVAL_MS);
    this.ackFlushTimer.unref?.();
  }

  private stopAckFlushPoller(): void {
    if (this.ackFlushTimer) clearInterval(this.ackFlushTimer);
    this.ackFlushTimer = null;
  }

  /**
   * Runs `fn` after all previously queued session mutations settled,
   * blocking later ones until it completes.
   */
  private withSessionLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.sessionMutation.catch(() => undefined).then(fn);
    this.sessionMutation = run.catch(() => undefined);
    return run;
  }

  private withLifecycleLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lifecycleMutation.catch(() => undefined).then(fn);
    this.lifecycleMutation = run.catch(() => undefined);
    return run;
  }

  /**
   * Returns the active default session, replacing it first when it
   * terminated itself (e.g. fatal error) so input and leases are not lost.
   * This is a safety net — the `onTerminated` hook should already have
   * created a replacement.
   */
  private resolveDefaultSession(): Promise<AgentSession> {
    return this.withSessionLock(async () => {
      if (!this.started) throw new SessionHostUnavailableError();
      const session = this._session;
      if (session && session.status !== 'terminated') {
        this.restorePendingEvents(session);
        return session;
      }

      this.deps.logger.warn(
        { reason: session ? 'terminated' : 'not_found' },
        'Session unavailable — creating replacement',
      );
      const replacement = await this.createSession();
      if (this.started) return replacement;

      await replacement.close();
      if (this._session === replacement) this._session = null;
      throw new SessionHostUnavailableError();
    });
  }

  /**
   * Creates a new session, awaits its startup, and wires the
   * `onTerminated` hook so the host is notified proactively when the
   * session self-terminates.
   *
   * `this._session` is assigned synchronously before `await session.start()`
   * so lifecycle hooks observe the candidate being started.
   */
  private async createSession(): Promise<AgentSession> {
    const hooks: SessionHooks = {
      onTerminated: (info) => this.handleTerminated(info),
    };
    const sessionContext: SessionContext = {
      kind: 'default',
      name: 'main',
      sessionId: DEFAULT_SESSION_ID,
    };
    const session = this.deps.sessionFactory({
      mcp: this.deps.mcp,
      sessionContext,
      extensionFactories: [],
      introspectionScope: this.sessionsScope ?? this.deps.introspection,
      hooks,
      basePrompt: this.deps.basePrompt,
    });
    this._session = session;
    try {
      await session.start();
      if (session.status === 'terminated') {
        throw new Error('Default session terminated during startup');
      }
      this.restorePendingEvents(session);
      return session;
    } catch (error) {
      if (this._session === session) this._session = null;
      await session.close().catch((closeError: unknown) => {
        this.deps.logger.error(
          { error: closeError },
          'Default session cleanup failed after startup error',
        );
      });
      this.deps.logger.error({ error }, 'Default session startup failed');
      throw error;
    }
  }

  /**
   * Called when a session self-terminates (fatal error). Creates a
   * replacement session and re-dispatches any pending inbox content
   * so the user does not lose input.
   */
  private async handleTerminated(info: SessionTerminationInfo): Promise<void> {
    this.pendingEvents.push(...info.pendingEvents);
    this.deps.logger.warn(
      {
        sessionId: info.sessionId,
        reason: info.reason,
        pendingEvents: info.pendingEvents.length,
      },
      'Session self-terminated — creating replacement and re-dispatching pending input',
    );

    try {
      await this.resolveDefaultSession();
    } catch (error) {
      this.deps.logger.error(
        { error, pendingEvents: this.pendingEvents.length },
        'Default session replacement failed; pending input retained',
      );
    }
  }

  private restorePendingEvents(session: AgentSession): void {
    if (this.pendingEvents.length === 0) return;
    const events = this.pendingEvents;
    session.restorePendingEvents(events);
    this.pendingEvents = [];
  }
}

export function createSessionHost(deps: SessionHostDependencies): SessionHost {
  return new SessionHostModule({
    logger: deps.logging.child({
      name: 'session-host',
      bindings: { module: 'session-host' },
    }),
    mcp: deps.mcp,
    introspection: deps.introspection,
    sessionFactory: deps.sessionFactory,
    basePrompt: deps.basePrompt,
  });
}
