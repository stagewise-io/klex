import { randomUUID } from 'node:crypto';

import { SpanKind } from '@opentelemetry/api';

import type { ModuleLogger, RootLogger } from '@stagewise/logger';

import type { Config } from '@/config';
import type { IntrospectionScope } from '@/introspection';
import type { Mcp, McpPushNotification } from '@/mcp';
import type { ModelProvider } from '@/model-provider';
import {
  type ContextDataUIPart,
  type SessionInboxEvent,
  SessionInboxPriority,
} from '@/session/inbox';
import type {
  AgentSession,
  SessionHooks,
  SessionInfo,
  SessionTerminationInfo,
} from '@/session/types';
import { recordErrorOnSpan, tracer } from '@/tracing';

import {
  callRoutingLlm,
  type RoutingDecision,
  type SessionRoutingInfo,
} from './routing-decision';

/**
 * Builds a short text preview of event content for the routing LLM.
 * Text is truncated to 32 characters. Other modalities become placeholders.
 */
function buildContentPreview(content: ContextDataUIPart['content']): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text') {
      parts.push(
        block.text.length > 32 ? `${block.text.slice(0, 32)}…` : block.text,
      );
    } else if (block.type === 'image') {
      parts.push('[image]');
    } else if (block.type === 'audio') {
      // Estimate duration from base64 data size (rough heuristic).
      const bytes = Math.floor((block.data.length * 3) / 4);
      const seconds = Math.max(1, Math.round(bytes / 16000));
      parts.push(`[audio: ${seconds}sec]`);
    } else if (block.type === 'resource_link') {
      parts.push(`[resource_link: ${block.name}]`);
    } else if (block.type === 'resource') {
      parts.push(`[resource: ${block.resource.uri}]`);
    }
  }
  return parts.join(' ');
}

export interface RouterDependencies {
  logging: RootLogger;
  mcp: Mcp;
  introspection: IntrospectionScope;
  config: Config;
  modelProvider: ModelProvider;
  createChatSession: (
    hooks: SessionHooks,
    introspectionScope: IntrospectionScope,
  ) => AgentSession;
}

export interface Router {
  start(): Promise<void>;
  close(): Promise<void>;

  /**
   * Send an input event into the router. The router uses an LLM to decide
   * which session receives it, assigns priority, and optionally updates
   * the session summary.
   */
  sendInput(event: SessionInboxEvent): Promise<void>;

  /**
   * Returns a snapshot of all active sessions.
   */
  getSessions(): SessionInfo[];
}

interface RouterSessionEntry {
  session: AgentSession;
  shortId: string;
  summary: string | null;
}

class RouterModule implements Router {
  private sessions = new Map<string, RouterSessionEntry>();
  private started = false;
  private pushNotificationUnsub: (() => void) | undefined;
  private sessionsScope: IntrospectionScope | null = null;
  private routingQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly deps: {
      logger: ModuleLogger;
      mcp: Mcp;
      introspection: IntrospectionScope;
      config: Config;
      modelProvider: ModelProvider;
      createChatSession: (
        hooks: SessionHooks,
        introspectionScope: IntrospectionScope,
      ) => AgentSession;
    },
  ) {}

  async start(): Promise<void> {
    if (this.started) return;

    // Register router state in the introspection tree.
    const routerScope = this.deps.introspection.child('router');
    routerScope.introspect(() => ({
      started: this.started,
      sessionCount: this.sessions.size,
      sessions: this.buildSessionIntrospection(),
    }));
    this.sessionsScope = this.deps.introspection.child('sessions');

    await this.createSession();

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

    for (const entry of this.sessions.values()) {
      await entry.session.close();
    }
    this.sessions.clear();

    this.sessionsScope = null;
    this.started = false;
    this.deps.logger.info('Router stopped');
  }

  async sendInput(event: SessionInboxEvent): Promise<void> {
    this.routingQueue = this.routingQueue.then(() =>
      this.routeAndDispatch(event),
    );
    return this.routingQueue;
  }

  getSessions(): SessionInfo[] {
    return [...this.sessions.values()].map((entry) =>
      entry.session.getSessionInfo(),
    );
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Converts a Push Notification from an MCP server into a session inbox event
   * and forwards it to the router for LLM-based routing.
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
        if (value === null || value === undefined || key in metadata) continue;
        metadata[key] = value;
      }
    }

    const inboxEvent: SessionInboxEvent = {
      sourceEnv: namespace,
      context: {
        sourceEnv: namespace,
        metadata,
        content,
      },
    };
    await this.sendInput(inboxEvent);
  }

  /**
   * Routes an event to the appropriate session using the routing LLM.
   * Serialized via routingQueue to prevent race conditions.
   *
   * The entire routing operation is wrapped in a `router.route` span that
   * records the active session list, the LLM routing decision (if any),
   * and the final dispatch target — providing full observability into the
   * routing process.
   */
  private async routeAndDispatch(event: SessionInboxEvent): Promise<void> {
    const routingInfo = this.buildSessionRoutingInfo();
    const routingModels = this.deps.config.getModelSelection('routing');
    const effectiveModels =
      routingModels.length > 0
        ? routingModels
        : this.deps.config.getModelSelection('chat');

    const span = tracer.startSpan('router.route', {
      attributes: {
        'klex.router.source_env': event.sourceEnv,
        'klex.router.session_count': routingInfo.length,
        'klex.router.sessions': JSON.stringify(
          routingInfo.map((s) => ({ shortId: s.shortId, status: s.status })),
        ),
        'klex.router.routing_models': effectiveModels.join(','),
        'klex.router.has_routing_models': effectiveModels.length > 0,
        'klex.router.using_chat_fallback': routingModels.length === 0,
      },
      kind: SpanKind.INTERNAL,
    });

    try {
      let decision: RoutingDecision | null = null;
      try {
        decision = await callRoutingLlm({
          logger: this.deps.logger,
          modelProvider: this.deps.modelProvider,
          routingModels: effectiveModels,
          sessions: routingInfo,
          eventMetadata: event.context.metadata,
          sourceEnv: event.sourceEnv,
          contentPreview: buildContentPreview(event.context.content),
          presetPriority: event.priority
            ? SessionInboxPriority[event.priority]
            : undefined,
        });
      } catch (error) {
        this.deps.logger.error(
          { error },
          'Routing LLM call threw unexpectedly — using fallback routing',
        );
      }

      // Record the routing decision on the span.
      if (decision) {
        const isNew = decision.sessionId === '';
        span.setAttributes({
          'klex.router.decision.choice': isNew ? 'new' : 'existing',
          'klex.router.decision.priority': decision.priority,
        });
        if (decision.sessionId !== '') {
          span.setAttribute(
            'klex.router.decision.session_id',
            decision.sessionId,
          );
        }
        if (decision.summary !== '') {
          span.setAttribute('klex.router.decision.summary', decision.summary);
        }
      } else {
        span.setAttribute('klex.router.decision.choice', 'fallback');
      }

      const { entry, priority, summary } = this.resolveTarget(
        decision,
        event.priority,
      );

      // Record the final dispatch target.
      span.setAttributes({
        'klex.router.target_short_id': entry.shortId,
        'klex.router.target_priority': SessionInboxPriority[priority],
        'klex.router.target_is_new_session':
          decision === null ||
          decision.sessionId === '' ||
          !this.sessions.has(decision.sessionId),
      });

      // Update summary if the LLM provided a non-empty one.
      if (summary !== null) {
        entry.summary = summary;
        entry.session.setSummary(summary);
      }

      // If the session terminated itself, create a replacement.
      if (entry.session.status === 'terminated') {
        this.deps.logger.warn(
          { shortId: entry.shortId },
          'Target session terminated — creating replacement',
        );
        this.sessions.delete(entry.shortId);
        const replacement = await this.createSession();
        replacement.session.restorePendingEvents([]);
        event.priority = priority;
        replacement.session.inbox.send(event);
        return;
      }

      event.priority = priority;
      entry.session.inbox.send(event);

      this.deps.logger.debug(
        {
          sourceEnv: event.sourceEnv,
          shortId: entry.shortId,
          priority: SessionInboxPriority[priority],
        },
        'Router dispatched input to session',
      );
    } catch (error) {
      recordErrorOnSpan(span, error);
      throw error;
    } finally {
      span.end();
    }
  }

  /**
   * Resolves the target session entry, priority, and summary from the
   * routing decision. Falls back to default behavior when the decision
   * is null (all models failed) or references a non-existent session.
   */
  private resolveTarget(
    decision: RoutingDecision | null,
    presetPriority?: SessionInboxPriority,
  ): {
    entry: RouterSessionEntry;
    priority: SessionInboxPriority;
    summary: string | null;
  } {
    if (decision === null) {
      // Fallback: first active session or create new.
      // Use preset priority if provided, otherwise Medium.
      const entry = this.firstActiveOrCreate();
      return {
        entry,
        priority: presetPriority ?? SessionInboxPriority.Medium,
        summary: null,
      };
    }

    // If the event has a preset priority, use it; otherwise use the LLM's.
    const priority = presetPriority ?? this.mapPriority(decision.priority);

    if (decision.sessionId !== '') {
      const entry = this.sessions.get(decision.sessionId);
      if (entry) {
        return { entry, priority, summary: decision.summary || null };
      }
      // Hallucinated session ID — create a new session.
      this.deps.logger.warn(
        { sessionId: decision.sessionId },
        'Routing LLM referenced non-existent session — creating new one',
      );
    }

    // Create a new session.
    const newEntry = this.createSessionSync();
    void newEntry.session.start().catch((error) => {
      this.deps.logger.error(
        { error, shortId: newEntry.shortId },
        'New session start failed',
      );
    });
    return { entry: newEntry, priority, summary: decision.summary || null };
  }

  /**
   * Returns the first active session entry, or creates a new one if
   * none exist.
   */
  private firstActiveOrCreate(): RouterSessionEntry {
    for (const entry of this.sessions.values()) {
      if (entry.session.status !== 'terminated') {
        return entry;
      }
    }
    // No active sessions — create one. We use createSessionSync to
    // avoid blocking the serialized routing queue.
    const entry = this.createSessionSync();
    void entry.session.start().catch((error) => {
      this.deps.logger.error(
        { error, shortId: entry.shortId },
        'Fallback session start failed',
      );
    });
    return entry;
  }

  /**
   * Builds the routing info snapshot for all active sessions.
   */
  private buildSessionRoutingInfo(): SessionRoutingInfo[] {
    const info: SessionRoutingInfo[] = [];
    for (const entry of this.sessions.values()) {
      if (entry.session.status === 'terminated') continue;
      const sessionInfo = entry.session.getSessionInfo();
      info.push({
        shortId: entry.shortId,
        summary: entry.summary,
        status: sessionInfo.status,
        runtimeState: sessionInfo.runtimeState,
      });
    }
    return info;
  }

  /**
   * Builds a detailed snapshot of all sessions for introspection.
   * Includes router-tracked state (shortId, summary) plus session
   * lifecycle info (status, runtimeState, turns, messageCount).
   */
  private buildSessionIntrospection(): object[] {
    const sessions: object[] = [];
    for (const entry of this.sessions.values()) {
      const si = entry.session.getSessionInfo();
      sessions.push({
        shortId: entry.shortId,
        sessionId: si.id,
        summary: si.summary ?? entry.summary,
        status: si.status,
        runtimeState: si.runtimeState,
        turns: si.turns,
        messageCount: si.messageCount,
        model: si.model,
        createdAt: si.createdAt,
      });
    }
    return sessions;
  }

  /**
   * Maps a routing priority string to the SessionInboxPriority enum.
   */
  private mapPriority(p: 'low' | 'medium' | 'high'): SessionInboxPriority {
    return p === 'high'
      ? SessionInboxPriority.High
      : p === 'low'
        ? SessionInboxPriority.Low
        : SessionInboxPriority.Medium;
  }

  /**
   * Generates a 4-character hex short ID, checking for collisions.
   */
  private generateShortId(): string {
    let id = randomUUID().slice(0, 4);
    while (this.sessions.has(id)) {
      id = randomUUID().slice(0, 4);
    }
    return id;
  }

  /**
   * Creates a new session entry synchronously (without awaiting start).
   * The session is stored in the map immediately so concurrent calls
   * see it. start() must be awaited separately.
   */
  private createSessionSync(): RouterSessionEntry {
    const shortId = this.generateShortId();
    const hooks: SessionHooks = {
      onTerminated: (info) => this.handleTerminated(info),
    };
    const session = this.deps.createChatSession(
      hooks,
      this.sessionsScope ?? this.deps.introspection,
    );
    session.setShortId(shortId);

    const entry: RouterSessionEntry = { session, shortId, summary: null };
    this.sessions.set(shortId, entry);

    this.deps.logger.info(
      { shortId, sessionId: session.getSessionInfo().id },
      'Router created session',
    );

    return entry;
  }

  /**
   * Creates a new session, awaits its startup, and wires the
   * `onTerminated` hook. Returns the session entry.
   */
  private async createSession(): Promise<RouterSessionEntry> {
    const entry = this.createSessionSync();
    await entry.session.start().catch((error) => {
      this.deps.logger.error(
        { error, shortId: entry.shortId },
        'Session start failed — tools may be unavailable',
      );
    });
    return entry;
  }

  /**
   * Called when a session self-terminates (fatal error). Removes it
   * from the session map and creates a replacement, re-dispatching
   * any pending inbox content.
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

    // Find and remove the terminated session from the map.
    // The terminated session has already removed itself from the
    // introspection tree via its close() method.
    for (const [shortId, entry] of this.sessions) {
      if (entry.session.getSessionInfo().id === info.sessionId) {
        this.sessions.delete(shortId);
        break;
      }
    }

    // Create the replacement session (registered with fresh hooks).
    // Awaiting ensures the session is fully started before pending events
    // are restored — no race between inbox delivery and resource startup.
    const replacement = await this.createSession();

    // Re-dispatch pending inbox events so the user does not lose input.
    replacement.session.restorePendingEvents(info.pendingEvents);
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
    config: deps.config,
    modelProvider: deps.modelProvider,
    createChatSession: deps.createChatSession,
  });
}
