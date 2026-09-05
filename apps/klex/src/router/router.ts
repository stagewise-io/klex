import type { ModuleLogger, RootLogger } from '@stagewise/logger';

import type { IntrospectionScope } from '@/introspection';
import type { Mcp, McpPushNotification } from '@/mcp';
import {
  type ContextDataUIPart,
  type SessionInboxEvent,
  SessionInboxUrgency,
} from '@/session/inbox';
import type {
  AgentSession,
  SessionHooks,
  SessionTerminationInfo,
} from '@/session/types';

export interface RouterDependencies {
  logging: RootLogger;
  mcp: Mcp;
  introspection: IntrospectionScope;
  createChatSession: (
    hooks: SessionHooks,
    introspectionScope: IntrospectionScope,
    router: RouterApi,
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

  constructor(
    private readonly deps: {
      logger: ModuleLogger;
      mcp: Mcp;
      introspection: IntrospectionScope;
      createChatSession: (
        hooks: SessionHooks,
        introspectionScope: IntrospectionScope,
        router: RouterApi,
      ) => AgentSession;
    },
  ) {}

  async start(): Promise<void> {
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

    this.session = await this.createSession();

    this.pushNotificationUnsub = this.deps.mcp.onPushNotification((ev) =>
      this.handlePushNotification(ev),
    );

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

    this.deps.introspection.removeChild('sessions');
    this.deps.introspection.removeChild('router');
    this.sessionsScope = null;
    this.started = false;
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
      {
        sourceEnv: event.sourceEnv,
        urgency: SessionInboxUrgency[event.urgency],
      },
      'Router dispatching input to session',
    );

    session.inbox.send(event);
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

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
    // introspection tree via its close() method.

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
    introspection: deps.introspection,
    createChatSession: deps.createChatSession,
  });
}
