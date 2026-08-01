import type { ModuleLogger, RootLogger } from '@stagewise/logger';

import type { Mcp, McpPushNotification } from '@/mcp';
import {
  type ContextDataUIPart,
  type SessionInboxEvent,
  SessionInboxPriority,
  validateInlineAudio,
  validateInlineImage,
} from '@/session/inbox';
import type {
  AgentSession,
  SessionHooks,
  SessionInfo,
  SessionTerminationInfo,
} from '@/session/types';

export interface RouterDependencies {
  logging: RootLogger;
  mcp: Mcp;
  createChatSession: (hooks: SessionHooks, mcp: Mcp) => AgentSession;
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
      createChatSession: (hooks: SessionHooks, mcp: Mcp) => AgentSession;
    },
  ) {}

  async start(): Promise<void> {
    if (this.started) return;

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
   * - `metadata`  ← event identity, type, namespace, and timestamp
   * - `content`   ← ordered MCP text blocks plus serialized event data
   */
  private async handlePushNotification(ev: McpPushNotification): Promise<void> {
    const { event, namespace } = ev;
    const content: ContextDataUIPart['content'] = [];
    for (const block of event.content) {
      if (block.type === 'text') {
        content.push({ type: 'text', text: block.text });
        continue;
      }
      if (block.type === 'image') {
        const validation = validateInlineImage(block.mimeType, block.data);
        if (validation.valid) {
          content.push({
            type: 'image',
            mimeType: block.mimeType,
            data: block.data,
          });
          continue;
        }

        content.push({
          type: 'text',
          text: `<unsupported-image mime-type="${block.mimeType}" reason="${validation.reason}" />`,
        });
        this.deps.logger.warn(
          {
            eventId: event.eventId,
            mimeType: block.mimeType,
            reason: validation.reason,
            decodedBytes: validation.decodedBytes,
          },
          'Router rejected invalid Push Notification image',
        );
        continue;
      }
      if (block.type !== 'audio') continue;

      const validation = validateInlineAudio(block.mimeType, block.data);
      if (validation.valid) {
        content.push({
          type: 'audio',
          mimeType: block.mimeType,
          data: block.data,
        });
        continue;
      }

      content.push({
        type: 'text',
        text: `<unsupported-audio mime-type="${block.mimeType}" reason="${validation.reason}" />`,
      });
      this.deps.logger.warn(
        {
          eventId: event.eventId,
          mimeType: block.mimeType,
          reason: validation.reason,
          decodedBytes: validation.decodedBytes,
        },
        'Router rejected invalid Push Notification audio',
      );
    }
    if (event.data !== undefined) {
      content.push({
        type: 'text',
        text: `Event data: ${stableJsonStringify(event.data)}`,
      });
    }

    const unsupportedTypes = event.content
      .filter(
        (block) =>
          block.type !== 'text' &&
          block.type !== 'image' &&
          block.type !== 'audio',
      )
      .map((block) => block.type);
    if (unsupportedTypes.length > 0) {
      this.deps.logger.warn(
        { eventId: event.eventId, contentTypes: unsupportedTypes },
        'Router omitted unsupported Push Notification content blocks',
      );
    }

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
    const session = this.deps.createChatSession(hooks, this.deps.mcp);
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

function stableJsonStringify(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (typeof input !== 'object' || input === null) return input;
    return Object.fromEntries(
      Object.entries(input)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalize(entry)]),
    );
  };
  return JSON.stringify(normalize(value));
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
