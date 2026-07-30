import type { ModuleLogger, RootLogger } from '@stagewise/logger';

import type { Mcp, McpPushNotification } from '@/mcp';
import { type SessionInboxEvent, SessionInboxPriority } from '@/session/inbox';
import type {
  AgentSession,
  SessionHooks,
  SessionInfo,
  SessionTerminationInfo,
} from '@/session/types';

export interface RouterDependencies {
  logging: RootLogger;
  mcp: Mcp;
  createChatSession: (hooks: SessionHooks) => AgentSession;
}

export interface Router {
  start(): Promise<void>;
  close(): Promise<void>;

  /**
   * Send an input event into the router. The router decides internally
   * which session receives it. Currently always routes to the single
   * primary session.
   */
  sendInput(event: SessionInboxEvent): Promise<void>;

  /**
   * Returns observability info for all live sessions.
   */
  getSessions(): SessionInfo[];
}

class RouterModule implements Router {
  private session: AgentSession | null = null;
  private started = false;
  private pushNotificationUnsub: (() => void) | undefined;

  constructor(
    private readonly deps: {
      logger: ModuleLogger;
      mcp: Mcp;
      createChatSession: (hooks: SessionHooks) => AgentSession;
    },
  ) {}

  async start(): Promise<void> {
    if (this.started) return;

    this.session = await this.createSession();

    this.pushNotificationUnsub = this.deps.mcp.onPushNotification((ev) => {
      this.handlePushNotification(ev);
    });

    this.started = true;
    this.deps.logger.info('Router started');
  }

  async close(): Promise<void> {
    if (!this.started) return;

    this.pushNotificationUnsub?.();
    this.pushNotificationUnsub = undefined;

    if (this.session) {
      await this.session.close();
      this.deps.logger.info('Router closed session');
    }
    this.session = null;

    this.started = false;
    this.deps.logger.info('Router stopped');
  }

  async sendInput(event: SessionInboxEvent): Promise<void> {
    let session = this.session;

    // If the session terminated itself (e.g. fatal error), replace it
    // with a fresh one so input is not lost. This is a safety net — the
    // onTerminated hook should already have created a replacement.
    if (!session || session.status === 'terminated') {
      this.deps.logger.warn(
        { reason: session ? 'terminated' : 'not_found' },
        'Session unavailable — creating replacement',
      );
      session = await this.createSession();
    }

    this.deps.logger.debug(
      { sourceEnv: event.sourceEnv, priority: event.priority },
      'Router dispatching input to session',
    );

    session.inbox.send(event);
  }

  getSessions(): SessionInfo[] {
    const session = this.session;
    if (!session) return [];
    return [session.getSessionInfo()];
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Converts a Push Notification from an MCP server into a session inbox event
   * and forwards it to the primary session.
   *
   * - `sourceEnv` ← `event.sourceId`
   * - `metadata`  ← `{ type, createdAt }`
   * - `content`   ← payload serialized as a single text part
   */
  private handlePushNotification(ev: McpPushNotification): void {
    const { event, namespace } = ev;
    const inboxEvent: SessionInboxEvent = {
      sourceEnv: event.sourceId,
      priority: SessionInboxPriority.Medium,
      context: {
        sourceEnv: event.sourceId,
        metadata: {
          eventId: event.eventId,
          namespace,
          type: event.type,
          createdAt: event.createdAt,
        },
        content: [{ type: 'text', text: JSON.stringify(event.payload) }],
      },
    };
    void this.sendInput(inboxEvent);
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
    const session = this.deps.createChatSession(hooks);
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

    // Create the replacement session (registered with fresh hooks).
    // Awaiting ensures the session is fully started before pending events
    // are restored — no race between inbox delivery and resource startup.
    const replacement = await this.createSession();

    // Re-dispatch pending inbox events so the user does not lose input.
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
    createChatSession: deps.createChatSession,
  });
}
