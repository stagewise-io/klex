import { randomUUID } from 'node:crypto';

import type { ModuleLogger, RootLogger } from '@stagewise/logger';

import type { IntrospectionScope } from '@/introspection';
import type { ExtensionFactory } from '@/session/chat/extensions/extension-api';
import type { ExtendedUIMessage } from '@/session/chat/message-types';
import {
  type ContextDataUIPart,
  SessionInboxClosedError,
  SessionInboxUrgency,
} from '@/session/inbox';
import type {
  ChatSessionHandle,
  SessionContext,
  SessionFactory,
  SessionHooks,
  SessionInfo,
  SessionTerminationInfo,
} from '@/session/types';

export type { GodMessageDataUIPart } from '@/session/chat/message-types';
export type { ContextDataUIPart } from '@/session/inbox';

export type GodMessagesErrorCode =
  | 'not-running'
  | 'reset-in-progress'
  | 'session-busy';

export class GodMessagesError extends Error {
  constructor(
    readonly code: GodMessagesErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GodMessagesError';
  }
}

export interface GodMessages {
  start(): Promise<void>;
  sendGodMessage(
    content: ContextDataUIPart['content'],
  ): Promise<{ sessionId: string }>;
  close(): Promise<void>;
  getSessionInfo(): SessionInfo | null;
  getMessages(): readonly ExtendedUIMessage[];
  resetSession(): Promise<{ sessionId: string }>;
}

export interface GodMessagesDependencies {
  logging: RootLogger;
  sessionFactory: SessionFactory;
  /** Extensions to load in god sessions (typically the trust extension + memory). */
  extensionFactories: ExtensionFactory[];
  introspection: IntrospectionScope;
  basePrompt: string;
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

  /**
   * True while `resetSession` is in progress. Gates concurrent
   * `sendGodMessage` calls (they throw) and `handleTerminated` (it becomes
   * a no-op so the reset logic owns fresh-session creation).
   */
  private resetting = false;

  constructor(
    private readonly deps: {
      logger: ModuleLogger;
      sessionFactory: SessionFactory;
      extensionFactories: ExtensionFactory[];
      introspection: IntrospectionScope;
      basePrompt: string;
    },
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.ensureSessionsScope();
    try {
      this.session = await this.ensureSession();
    } catch (error) {
      this.started = false;
      this.removeSessionsScope();
      this.deps.logger.error(
        { error },
        'God messages startup failed because its session could not start',
      );
      throw error;
    }
  }

  async sendGodMessage(
    content: ContextDataUIPart['content'],
  ): Promise<{ sessionId: string }> {
    if (!this.started) {
      throw new GodMessagesError(
        'not-running',
        'God messages module is not running',
      );
    }
    if (this.resetting) {
      throw new GodMessagesError(
        'reset-in-progress',
        'God session is being reset',
      );
    }
    const session = await this.ensureSession();
    if (!this.started || this.resetting || this.session !== session) {
      throw new GodMessagesError(
        this.resetting ? 'reset-in-progress' : 'not-running',
        this.resetting
          ? 'God session is being reset'
          : 'God messages module is not running',
      );
    }

    const message: ExtendedUIMessage = {
      id: randomUUID(),
      role: 'user',
      parts: [{ type: 'data-god-message', data: { content } }],
    };

    try {
      session.inbox.sendMessage(message, SessionInboxUrgency.Default);
      return { sessionId: session.sessionId };
    } catch (error) {
      if (!(error instanceof SessionInboxClosedError)) throw error;
    }

    // Self-termination closes the inbox before its callback replaces the
    // session. Replace it here rather than dropping a directive in that gap.
    if (this.session === session) this.session = null;
    const replacement = await this.ensureSession();
    if (!this.started || this.resetting || this.session !== replacement) {
      throw new GodMessagesError(
        this.resetting ? 'reset-in-progress' : 'not-running',
        this.resetting
          ? 'God session is being reset'
          : 'God messages module is not running',
      );
    }
    replacement.inbox.sendMessage(message, SessionInboxUrgency.Default);
    return { sessionId: replacement.sessionId };
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
    this.removeSessionsScope();
  }

  getSessionInfo(): SessionInfo | null {
    return this.session?.getSessionInfo() ?? null;
  }

  getMessages(): readonly ExtendedUIMessage[] {
    return this.session?.getMessages() ?? [];
  }

  async resetSession(): Promise<{ sessionId: string }> {
    if (!this.started) {
      throw new GodMessagesError(
        'not-running',
        'God messages module is not running',
      );
    }
    if (this.resetting) {
      throw new GodMessagesError(
        'reset-in-progress',
        'God session is already being reset',
      );
    }

    const oldSession = this.session;
    const oldCreating = this.creatingSession;

    // If a session exists, check its runtime state — only idle and
    // terminated are resettable.
    if (oldSession) {
      const info = oldSession.getSessionInfo();
      if (info.runtimeState !== 'idle' && info.runtimeState !== 'terminated') {
        throw new GodMessagesError(
          'session-busy',
          `God session is busy (state: ${info.runtimeState}). Reset allowed only when idle or terminated.`,
        );
      }
    }

    this.resetting = true;
    this.session = null;

    try {
      // If there's an in-flight creation (e.g. from a concurrent
      // handleTerminated), await it and close that session — it's a
      // replacement we want to discard for a clean slate.
      if (oldCreating) {
        const s = await oldCreating.catch(() => null);
        // createSession() sets this.session synchronously inside the
        // promise — null it again so ensureSession creates fresh.
        this.session = null;
        if (s) {
          await s.close().catch((error: unknown) => {
            this.deps.logger.error(
              { error },
              'God session (in-flight replacement) close failed during reset',
            );
          });
        }
      }

      // Close the old session if one existed (idempotent via closePromise).
      if (oldSession) {
        await oldSession.close().catch((error: unknown) => {
          this.deps.logger.error(
            { error },
            'God session close failed during reset',
          );
        });
      }

      if (!this.started) {
        throw new GodMessagesError(
          'not-running',
          'God messages module stopped during reset',
        );
      }

      const fresh = await this.ensureSession();
      return { sessionId: fresh.sessionId };
    } finally {
      this.resetting = false;
    }
  }

  private async createSession(): Promise<ChatSessionHandle> {
    if (!this.started) {
      throw new GodMessagesError(
        'not-running',
        'God messages module is not running',
      );
    }
    const sessionsScope = this.ensureSessionsScope();

    const hooks: SessionHooks = {
      onTerminated: (info) => this.handleTerminated(info),
    };

    const sessionId = randomUUID();
    const sessionContext: SessionContext = {
      kind: 'god',
      name: 'god',
      sessionId,
    };

    const session = this.deps.sessionFactory({
      mcp: null,
      sessionContext,
      extensionFactories: this.deps.extensionFactories,
      introspectionScope: sessionsScope,
      hooks,
      basePrompt: this.deps.basePrompt,
    });

    this.session = session;
    try {
      await session.start();
      return session;
    } catch (error) {
      if (this.session === session) this.session = null;
      await session.close().catch((closeError: unknown) => {
        this.deps.logger.error(
          { error: closeError },
          'God session cleanup failed after startup error',
        );
      });
      this.deps.logger.error({ error }, 'God session startup failed');
      throw error;
    }
  }

  private removeSessionsScope(): void {
    if (!this.sessionsScope) return;
    this.deps.introspection.removeChild('god-sessions');
    this.sessionsScope = null;
  }

  private ensureSessionsScope() {
    if (!this.sessionsScope) {
      this.sessionsScope = this.deps.introspection.child('god-sessions');
      this.sessionsScope.introspect(() => ({
        sessions:
          this.session && this.session.status === 'active'
            ? [this.session.getSessionInfo()]
            : [],
      }));
    }
    return this.sessionsScope;
  }

  private async ensureSession(): Promise<ChatSessionHandle> {
    if (!this.started) {
      throw new GodMessagesError(
        'not-running',
        'God messages module is not running',
      );
    }
    if (this.session) return this.session;
    if (!this.creatingSession) {
      this.creatingSession = this.createSession().finally(() => {
        this.creatingSession = null;
      });
    }
    return this.creatingSession;
  }

  private async handleTerminated(info: SessionTerminationInfo): Promise<void> {
    if (!this.started) {
      this.deps.logger.debug(
        { sessionId: info.sessionId },
        'Ignoring god session termination after shutdown',
      );
      return;
    }

    // During reset, the reset logic owns fresh-session creation.
    // A self-termination during reset would otherwise create a replacement
    // with re-dispatched pending events, defeating the clean-slate purpose.
    if (this.resetting) {
      this.deps.logger.warn(
        { sessionId: info.sessionId, reason: info.reason },
        'God session terminated during reset — ignoring, reset will create fresh session',
      );
      return;
    }

    if (this.session?.sessionId !== info.sessionId) {
      this.deps.logger.debug(
        { sessionId: info.sessionId },
        'Ignoring stale god session termination',
      );
      return;
    }

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
    sessionFactory: deps.sessionFactory,
    extensionFactories: deps.extensionFactories,
    introspection: deps.introspection,
    basePrompt: deps.basePrompt,
  });
}
