import type { ModuleLogger, RootLogger } from '@stagewise/logger';

import type { IntrospectionScope } from '@/introspection';
import type { Mcp, McpPushNotification } from '@/mcp';
import {
  type ContextDataUIPart,
  type SessionInboxEvent,
  SessionInboxUrgency,
} from '@/session/inbox';
import type {
  InteractionLease,
  InteractionLeaseRequest,
} from '@/session/interaction';
import {
  type AgentSession,
  DEFAULT_SESSION_ID,
  type SessionHooks,
  type SessionTerminationInfo,
} from '@/session/types';

export { DEFAULT_SESSION_ID } from '@/session/types';

export interface RouterDependencies {
  logging: RootLogger;
  mcp: Mcp;
  introspection: IntrospectionScope;
  createChatSession: (
    hooks: SessionHooks,
    introspectionScope: IntrospectionScope,
    router: RouterApi,
    sessionId: string,
  ) => AgentSession;
}

/**
 * The subset of router capabilities exposed to extensions. Extensions
 * can send input events that the router dispatches to the active session.
 * This survives session termination — the router creates a replacement
 * session if the current one has terminated.
 */
export interface RouterApi {
  /**
   * Send an input event into the router. The router decides internally
   * which session receives it. Currently always routes to the single
   * primary session.
   */
  sendInput(event: SessionInboxEvent): Promise<void>;

  /**
   * Acquire an exclusive interaction lease on the generation lane of the
   * active primary session. Callers (currently the realtime session
   * coordinator) use this as the stable conversation host: the lease
   * survives session replacement in the sense that acquisition always
   * targets the session that is primary at acquisition time, never a
   * stale one.
   *
   * Rejects with {@link RouterUnavailableError} when the router is not
   * running.
   */
  acquireInteractionLease(
    request: InteractionLeaseRequest,
  ): Promise<InteractionLease>;
}

/** Thrown when a lease is requested while the router is not running. */
export class RouterUnavailableError extends Error {
  constructor() {
    super('Router is not running — cannot acquire an interaction lease');
    this.name = 'RouterUnavailableError';
  }
}

export interface Router extends RouterApi {
  start(): Promise<void>;
  close(): Promise<void>;
}

class RouterModule implements Router {
  private session: AgentSession | null = null;
  private started = false;
  private pushNotificationUnsub: (() => void) | undefined;
  private sessionsScope: IntrospectionScope | null = null;

  /**
   * Serializes every mutation of {@link session} (creation, replacement)
   * against readers that must not observe a stale session — most notably
   * lease acquisition. Held only while the primary session is being
   * resolved, never while a lease handshake is in flight.
   */
  private sessionMutation: Promise<unknown> = Promise.resolve();

  /** Serializes start, shutdown, and lease handshakes. */
  private lifecycleMutation: Promise<unknown> = Promise.resolve();

  /** The lease currently handed out, if any. Cleared when it closes. */
  private activeLease: InteractionLease | null = null;

  constructor(
    private readonly deps: {
      logger: ModuleLogger;
      mcp: Mcp;
      introspection: IntrospectionScope;
      createChatSession: (
        hooks: SessionHooks,
        introspectionScope: IntrospectionScope,
        router: RouterApi,
        sessionId: string,
      ) => AgentSession;
    },
  ) {}

  start(): Promise<void> {
    return this.withLifecycleLock(() => this.startUnlocked());
  }

  private async startUnlocked(): Promise<void> {
    if (this.started) return;

    // Register router state in the introspection tree.
    this.deps.introspection
      .child('router')
      .introspect(() => ({ started: true }));
    this.sessionsScope = this.deps.introspection.child('sessions');
    this.sessionsScope.introspect(() => ({
      sessions:
        this.session && this.session.status === 'active'
          ? [this.session.getSessionInfo()]
          : [],
    }));

    this.session = await this.withSessionLock(() => this.createSession());

    this.pushNotificationUnsub = this.deps.mcp.onPushNotification((ev) =>
      this.handlePushNotification(ev),
    );

    this.started = true;
    this.deps.logger.info('Router started');
  }

  close(): Promise<void> {
    return this.withLifecycleLock(() => this.closeUnlocked());
  }

  private async closeUnlocked(): Promise<void> {
    if (!this.started) return;
    // Cleared first so a concurrent lease acquisition is rejected instead of
    // handshaking with a session that is about to close.
    this.started = false;

    this.pushNotificationUnsub?.();
    this.pushNotificationUnsub = undefined;

    // The lock drains any in-flight session creation so shutdown cannot race
    // a replacement into existence after the router stopped.
    await this.withSessionLock(async () => {
      if (this.session) {
        await this.session.close();
        this.deps.logger.info('Router closed session');
      }
      this.session = null;
      this.activeLease = null;
    });

    this.deps.introspection.removeChild('sessions');
    this.deps.introspection.removeChild('router');
    this.sessionsScope = null;
    this.deps.logger.info('Router stopped');
  }

  async sendInput(event: SessionInboxEvent): Promise<void> {
    if (!this.started) {
      this.deps.logger.warn(
        { sourceEnv: event.sourceEnv },
        'Router is not running — dropping input event',
      );
      return;
    }

    const session = await this.resolvePrimarySession();

    this.deps.logger.debug(
      {
        eventId: event.eventId,
        sourceEnv: event.sourceEnv,
        urgency: SessionInboxUrgency[event.urgency],
      },
      'Router dispatching input to session',
    );

    session.inbox.send(event);
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
    if (!this.started) throw new RouterUnavailableError();

    // Resolving the primary session is serialized against replacement, so
    // the handshake below never starts against a session the router has
    // already discarded. The handshake itself runs outside the lock: it can
    // wait for the chat loop to reach a safe boundary, and blocking
    // replacement for that long would deadlock termination handling.
    const session = await this.resolvePrimarySession();
    const lease = await session.acquireInteractionLease(request);

    this.activeLease = lease;
    void lease.closed
      .catch(() => undefined)
      .finally(() => {
        if (this.activeLease === lease) this.activeLease = null;
      });

    this.deps.logger.info(
      {
        leaseId: lease.id,
        sessionId: lease.sessionId,
        mode: request.mode,
        namespace: request.namespace,
      },
      'Router granted interaction lease on the primary session',
    );
    return lease;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

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
   * Returns the active primary session, replacing it first when it
   * terminated itself (e.g. fatal error) so input and leases are not lost.
   * This is a safety net — the `onTerminated` hook should already have
   * created a replacement.
   */
  private resolvePrimarySession(): Promise<AgentSession> {
    return this.withSessionLock(async () => {
      if (!this.started) throw new RouterUnavailableError();
      const session = this.session;
      if (session && session.status !== 'terminated') return session;

      this.deps.logger.warn(
        { reason: session ? 'terminated' : 'not_found' },
        'Session unavailable — creating replacement',
      );
      const replacement = await this.createSession();
      if (this.started) return replacement;

      await replacement.close();
      if (this.session === replacement) this.session = null;
      throw new RouterUnavailableError();
    });
  }

  /**
   * Converts a Push Notification from an MCP server into a session inbox event
   * and forwards it to the primary session.
   *
   * - `sourceEnv` ← MCP namespace
   * - `metadata`  ← event type, timestamp, and structured event data
   * - `content`   ← ordered MCP content blocks (text, image, audio,
   *                  resource_link, resource), mapped 1:1
   */
  private async handlePushNotification(ev: McpPushNotification): Promise<void> {
    const { event, namespace } = ev;
    const content: ContextDataUIPart['content'] = event.content
      .map((block) => {
        if (block.type === 'text')
          return { type: 'text', text: block.text } as const;
        if (block.type === 'image')
          return {
            type: 'image',
            mimeType: block.mimeType,
            data: block.data,
          } as const;
        if (block.type === 'audio')
          return {
            type: 'audio',
            mimeType: block.mimeType,
            data: block.data,
          } as const;
        if (block.type === 'resource_link')
          return {
            type: 'resource_link',
            uri: block.uri,
            name: block.name,
            title: block.title,
            description: block.description,
            mimeType: block.mimeType,
            size: block.size,
          } as const;
        if (block.type === 'resource') {
          const res = block.resource;
          return {
            type: 'resource',
            resource: {
              uri: res.uri,
              ...(res.mimeType ? { mimeType: res.mimeType } : {}),
              ...('text' in res ? { text: res.text } : {}),
              ...('blob' in res ? { blob: res.blob } : {}),
            },
          } as const;
        }
        return undefined;
      })
      .filter(
        (block): block is NonNullable<typeof block> => block !== undefined,
      );

    const metadata: ContextDataUIPart['metadata'] = {
      type: event.type,
      createdAt: event.createdAt,
    };

    // Merge structured event data into metadata so the model sees it
    // as context descriptors, not user-authored content.
    // Existing envelope keys take precedence over data keys.
    if (event.data !== undefined) {
      for (const [key, value] of Object.entries(event.data)) {
        if (value === null || key in metadata) continue;
        metadata[key] = value;
      }
    }

    const inboxEvent: SessionInboxEvent = {
      // Preserve the MCP event identity so downstream deduplication and
      // leased-interaction replay reference the same ID as the ack path.
      eventId: `${namespace}:${event.eventId}`,
      sourceEnv: namespace,
      urgency: SessionInboxUrgency.Default,
      context: {
        sourceEnv: namespace,
        metadata,
        content,
      },
    };
    await this.sendInput(inboxEvent);
  }

  /**
   * Creates a new session, awaits its startup, and wires the
   * `onTerminated` hook so the router is notified proactively when the
   * session self-terminates.
   *
   * `this.session` is assigned synchronously before `await session.start()`
   * so that a concurrent `sendInput` call sees the new session and does
   * not create a duplicate.
   */
  private async createSession(): Promise<AgentSession> {
    const hooks: SessionHooks = {
      onTerminated: (info) => this.handleTerminated(info),
    };
    const session = this.deps.createChatSession(
      hooks,
      this.sessionsScope ?? this.deps.introspection,
      this,
      DEFAULT_SESSION_ID,
    );
    this.session = session;
    await session.start().catch((error) => {
      this.deps.logger.error(
        { error },
        'Session start failed — tools may be unavailable',
      );
    });
    return session;
  }

  /**
   * Called when a session self-terminates (fatal error). Creates a
   * replacement session and re-dispatches any pending inbox content
   * so the user does not lose input.
   */
  private async handleTerminated(info: SessionTerminationInfo): Promise<void> {
    this.deps.logger.warn(
      {
        sessionId: info.sessionId,
        reason: info.reason,
        pendingEvents: info.pendingEvents.length,
      },
      'Session self-terminated — creating replacement and re-dispatching pending input',
    );

    // The terminated session has already removed itself from the
    // introspection tree via its close() method, and revoked any interaction
    // lease it held as part of termination. Dropping the reference here keeps
    // the router from handing a dead lease to a later caller.
    this.activeLease = null;

    // Create the replacement session (registered with fresh hooks).
    // Awaiting ensures the session is fully started before pending events
    // are restored — no race between inbox delivery and resource startup.
    // The lock serializes this against concurrent lease acquisition.
    const replacement = await this.withSessionLock(async () => {
      if (!this.started) return undefined;
      const candidate = await this.createSession();
      if (this.started) return candidate;

      await candidate.close();
      if (this.session === candidate) this.session = null;
      return undefined;
    });

    // Re-dispatch pending inbox events so the user does not lose input.
    if (replacement && this.started)
      replacement.restorePendingEvents(info.pendingEvents);
  }
}

export function createRouter(deps: RouterDependencies): Router {
  return new RouterModule({
    logger: deps.logging.child({
      name: 'router',
      bindings: { module: 'router' },
    }),
    mcp: deps.mcp,
    introspection: deps.introspection,
    createChatSession: deps.createChatSession,
  });
}
