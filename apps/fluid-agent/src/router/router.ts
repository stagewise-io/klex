import { randomUUID } from 'node:crypto';
import type { ModuleLogger, RootLogger } from '@stagewise/logger';
import type { AgentSession } from '@/session/types';

export type SessionId = string;

export interface RouterDependencies {
  logging: RootLogger;
  createChatSession: () => AgentSession;
}

export interface Router {
  start(): Promise<void>;
  close(): Promise<void>;
}

class RouterModule implements Router {
  private readonly sessions = new Map<SessionId, AgentSession>();
  private started = false;

  constructor(
    private readonly deps: {
      logger: ModuleLogger;
      createChatSession: () => AgentSession;
    },
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.deps.logger.info('Router started');
  }

  async close(): Promise<void> {
    if (!this.started) return;
    this.sessions.clear();
    this.started = false;
    this.deps.logger.info('Router stopped');
  }

  /**
   * Creates a new agent session, stores it, and returns its ID.
   *
   * Internal — not yet exposed through the public Router API.
   */
  private createSession(): SessionId {
    const sessionId = randomUUID();
    const session = this.deps.createChatSession();
    this.sessions.set(sessionId, session);
    this.deps.logger.info({ sessionId }, 'Router created session');
    return sessionId;
  }

  /**
   * Removes a session by ID.
   *
   * Internal — not yet exposed through the public Router API.
   *
   * `AgentSession` currently has no `close()` lifecycle, so deletion only
   * removes the reference from the registry. Once sessions become
   * lifecycle-managed, this should close the session before removing it.
   */
  private deleteSession(sessionId: SessionId): void {
    if (!this.sessions.delete(sessionId)) {
      this.deps.logger.warn(
        { sessionId },
        'Router deleteSession — session not found',
      );
      return;
    }
    this.deps.logger.info({ sessionId }, 'Router deleted session');
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
