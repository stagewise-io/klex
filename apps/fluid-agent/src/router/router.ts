import type { ModuleLogger, RootLogger } from '@stagewise/logger';

import { type SessionInboxEvent, SessionInboxPriority } from '@/session/inbox';
import type {
  AgentSession,
  SessionHooks,
  SessionTerminationInfo,
} from '@/session/types';

export interface RouterDependencies {
  logging: RootLogger;
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
  sendInput(event: SessionInboxEvent): void;
}

class RouterModule implements Router {
  private session: AgentSession | null = null;
  private started = false;

  constructor(
    private readonly deps: {
      logger: ModuleLogger;
      createChatSession: (hooks: SessionHooks) => AgentSession;
    },
  ) {}

  async start(): Promise<void> {
    if (this.started) return;

    this.session = this.createSession();

    this.started = true;
    this.deps.logger.info('Router started');
  }

  async close(): Promise<void> {
    if (!this.started) return;

    if (this.session) {
      await this.session.close();
      this.deps.logger.info('Router closed session');
    }
    this.session = null;

    this.started = false;
    this.deps.logger.info('Router stopped');
  }

  sendInput(event: SessionInboxEvent): void {
    let session = this.session;

    // If the session terminated itself (e.g. fatal error), replace it
    // with a fresh one so input is not lost. This is a safety net — the
    // onTerminated hook should already have created a replacement.
    if (!session || session.status === 'terminated') {
      this.deps.logger.warn(
        { reason: session ? 'terminated' : 'not_found' },
        'Session unavailable — creating replacement',
      );
      session = this.createSession();
      this.session = session;
    }

    this.deps.logger.debug(
      { sourceEnv: event.sourceEnv, priority: event.priority },
      'Router dispatching input to session',
    );

    session.inbox.send(event);
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Creates a new session and wires the `onTerminated` hook so the router
   * is notified proactively when the session self-terminates.
   */
  private createSession(): AgentSession {
    const hooks: SessionHooks = {
      onTerminated: (info) => this.handleTerminated(info),
    };
    const session = this.deps.createChatSession(hooks);
    this.session = session;
    return session;
  }

  /**
   * Called when a session self-terminates (fatal error). Creates a
   * replacement session and re-dispatches any pending inbox content
   * so the user does not lose input.
   */
  private handleTerminated(info: SessionTerminationInfo): void {
    this.deps.logger.warn(
      {
        sessionId: info.sessionId,
        reason: info.reason,
        pendingEvents: info.pendingEvents.length,
        pendingMessages: info.pendingMessages.length,
      },
      'Session self-terminated — creating replacement and re-dispatching pending input',
    );

    // Create the replacement session (registered with fresh hooks).
    const replacement = this.createSession();

    // Re-dispatch pending native messages first (preserving arrival order),
    // then pending context events. The original priority is lost when
    // draining, so we re-send at Medium (normal user input priority).
    const defaultPriority: SessionInboxPriority = SessionInboxPriority.Medium;
    for (const msg of info.pendingMessages) {
      replacement.inbox.sendMessage(msg, defaultPriority);
    }
    for (const event of info.pendingEvents) {
      replacement.inbox.send(event);
    }
  }
}

export function createRouter(deps: RouterDependencies): Router {
  return new RouterModule({
    logger: deps.logging.child({
      name: 'router',
      bindings: { module: 'router' },
    }),
    createChatSession: deps.createChatSession,
  });
}
