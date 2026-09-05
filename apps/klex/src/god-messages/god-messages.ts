import { randomUUID } from 'node:crypto';

import type { ModuleLogger, RootLogger } from '@stagewise/logger';

import type { IntrospectionScope } from '@/introspection';
import type { RouterApi } from '@/router';
import { type ContextDataUIPart, SessionInboxUrgency } from '@/session/inbox';
import type {
  ChatSessionHandle,
  SessionHooks,
  SessionTerminationInfo,
} from '@/session/types';

export type { GodMessageDataUIPart } from '@/session/chat/message-types';
export type { ContextDataUIPart } from '@/session/inbox';

export interface GodMessages {
  start(): Promise<void>;
  sendGodMessage(
    content: ContextDataUIPart['content'],
  ): Promise<{ sessionId: string }>;
  close(): Promise<void>;
}

/**
 * Factory that creates a chat session for the god-messages module.
 * Same signature as the router's `createChatSession` dependency —
 * `main.ts` assembles shared deps (config, modelProvider, mcp, etc.)
 * and provides the extension factory list (with the trust extension).
 */
export type CreateGodChatSession = (
  hooks: SessionHooks,
  introspectionScope: IntrospectionScope,
  router: RouterApi,
) => ChatSessionHandle;

export interface GodMessagesDependencies {
  logging: RootLogger;
  createChatSession: CreateGodChatSession;
  introspection: IntrospectionScope;
  router: RouterApi;
}

class GodMessagesModule implements GodMessages {
  private session: ChatSessionHandle | null = null;

  private started = false;

  private sessionsScope: IntrospectionScope | null = null;

  /**
   * In-flight session creation promise. Deduplicates concurrent calls so
   * that `sendGodMessage` and `handleTerminated` never create two sessions
   * at the same time — both await the same promise.
   */
  private creatingSession: Promise<ChatSessionHandle> | null = null;

  constructor(
    private readonly deps: {
      logger: ModuleLogger;
      createChatSession: CreateGodChatSession;
      introspection: IntrospectionScope;
      router: RouterApi;
    },
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const sessionsScope = this.ensureSessionsScope();
    sessionsScope.introspect(() => ({
      sessions:
        this.session && this.session.status === 'active'
          ? [this.session.getSessionInfo()]
          : [],
    }));
    await this.ensureSession();
  }

  async sendGodMessage(
    content: ContextDataUIPart['content'],
  ): Promise<{ sessionId: string }> {
    if (!this.started) throw new Error('God messages module is not running');
    const session = await this.ensureSession();

    session.inbox.sendMessage(
      {
        id: randomUUID(),
        role: 'user',
        parts: [{ type: 'data-god-message', data: { content } }],
      },
      SessionInboxUrgency.Default,
    );

    return { sessionId: session.sessionId };
  }

  async close(): Promise<void> {
    this.started = false;
    // Wait for any in-flight session creation before closing, otherwise
    // the newly created session would be orphaned (never closed).
    const pending = this.creatingSession;
    if (pending) await pending.catch(() => undefined);
    const session = this.session;
    this.session = null;
    if (session) {
      await session.close().catch((error: unknown) => {
        this.deps.logger.error({ error }, 'God session close failed');
      });
    }
    if (this.sessionsScope) {
      this.deps.introspection.removeChild('god-sessions');
      this.sessionsScope = null;
    }
  }

  private async createSession(): Promise<ChatSessionHandle> {
    if (!this.started) throw new Error('God messages module is not running');
    const sessionsScope = this.ensureSessionsScope();

    const hooks: SessionHooks = {
      onTerminated: (info) => this.handleTerminated(info),
    };

    const session = this.deps.createChatSession(
      hooks,
      sessionsScope,
      this.deps.router,
    );

    this.session = session;
    // Swallow start() errors — the session may still be partially
    // functional (inbox works even if tools fail to initialize). If the
    // session later self-terminates, onTerminated creates a replacement.
    await session.start().catch((error: unknown) => {
      this.deps.logger.error(
        { error },
        'God session start failed — tools may be unavailable',
      );
    });
    return session;
  }

  private ensureSessionsScope(): IntrospectionScope {
    if (!this.sessionsScope) {
      this.sessionsScope = this.deps.introspection.child('god-sessions');
    }
    return this.sessionsScope;
  }

  private async ensureSession(): Promise<ChatSessionHandle> {
    if (!this.started) throw new Error('God messages module is not running');
    if (this.session) return this.session;
    if (!this.creatingSession) {
      this.creatingSession = this.createSession().finally(() => {
        this.creatingSession = null;
      });
    }
    return this.creatingSession;
  }

  private async handleTerminated(info: SessionTerminationInfo): Promise<void> {
    if (!this.started || this.session?.sessionId !== info.sessionId) return;

    this.deps.logger.warn(
      {
        sessionId: info.sessionId,
        reason: info.reason,
        pendingEvents: info.pendingEvents.length,
      },
      'God session self-terminated — creating replacement',
    );

    this.session = null;
    await this.ensureSession();
  }
}

export function createGodMessages(deps: GodMessagesDependencies): GodMessages {
  return new GodMessagesModule({
    logger: deps.logging.child({
      name: 'god-messages',
      bindings: { module: 'god-messages' },
    }),
    createChatSession: deps.createChatSession,
    introspection: deps.introspection,
    router: deps.router,
  });
}
