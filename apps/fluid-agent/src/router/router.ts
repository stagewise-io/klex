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
