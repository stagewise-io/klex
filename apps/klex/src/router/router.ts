import { randomUUID } from 'node:crypto';

import { SpanKind } from '@opentelemetry/api';

import type { ModuleLogger, RootLogger } from '@stagewise/logger';

import type { Config } from '@/config';
import type { IntrospectionScope } from '@/introspection';
import type { Mcp, McpPushNotification } from '@/mcp';
import type { ProviderModelResolver } from '@/provider-registry';
import {
  type ContextDataUIPart,
  type SessionInboxEvent,
  SessionInboxUrgency,
} from '@/session/inbox';
import type {
  AgentSession,
  SessionHooks,
  SessionInfo,
  SessionTerminationInfo,
} from '@/session/types';
import { recordErrorOnSpan, tracer, withSpan } from '@/tracing';

import {
  buildContentPreview,
  callRoutingLlm,
  mapPriority,
  matchesRule,
  type RoutingRule,
  type SessionRoutingInfo,
  sameMatch,
} from './routing-decision';

export interface RouterDependencies {
  logging: RootLogger;
  mcp: Mcp;
  introspection: IntrospectionScope;
  config: Config;
  modelProvider: ProviderModelResolver;
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
   * Send an input event into the router. The router checks routing rules
   * first (deterministic key-value match), then calls the routing LLM
   * for events that match no rule.
   */
  sendInput(event: SessionInboxEvent): Promise<void>;

  /**
   * Returns a snapshot of all active sessions.
   */
  getSessions(): SessionInfo[];
}

export interface Router extends RouterApi {
  start(): Promise<void>;
  close(): Promise<void>;
}

interface RouterSessionEntry {
  session: AgentSession;
  shortId: string;
  routingRule: RoutingRule | null;
  /** MCP namespace that created this session. Rules are scoped by sourceEnv. */
  sourceEnv: string | null;
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
      modelProvider: ProviderModelResolver;
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
    const routerScope = this.deps.introspection.child('router');
    routerScope.introspect(() => ({
      started: this.started,
      sessionCount: this.sessions.size,
      sessions: this.buildSessionIntrospection(),
    }));
    this.sessionsScope = this.deps.introspection.child('sessions');
    this.sessionsScope.introspect(() => ({
      sessions: this.getSessions(),
    }));

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

    // Signal queued routing operations to bail out, then drain the
    // queue before clearing sessions so no queued work can recreate
    // sessions after shutdown.
    this.started = false;
    await this.routingQueue;
    this.routingQueue = Promise.resolve();

    for (const entry of this.sessions.values()) {
      await entry.session.close();
    }
    this.sessions.clear();

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

    this.routingQueue = this.routingQueue
      .then(() => this.routeAndDispatch(event))
      .catch((error) => {
        this.deps.logger.error(
          { error, sourceEnv: event.sourceEnv },
          'Routing operation failed',
        );
      });
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
   * Routes an event to the appropriate session using a two-branch
   * procedural flow:
   *
   * 1. **Rule check** — iterate active sessions and check if the event's
   *    metadata satisfies any session's routing rule. If a rule matches,
   *    dispatch immediately without an LLM call.
   * 2. **LLM fallback** — if no rule matches, call the routing LLM. The
   *    LLM decides whether to route to an existing session or create a
   *    new one. When creating a new conversation, the LLM also provides
   *    a routing rule that binds future events to the new session.
   *
   * Serialized via routingQueue to prevent race conditions.
   */
  private async routeAndDispatch(event: SessionInboxEvent): Promise<void> {
    if (!this.started) return;

    const span = tracer.startSpan('router.route', {
      attributes: {
        'klex.router.source_env': event.sourceEnv,
        'klex.router.session_count': this.sessions.size,
        'klex.router.sessions': JSON.stringify(
          [...this.sessions.values()].map((s) => ({
            shortId: s.shortId,
            status: s.session.status,
            routingRule: s.routingRule,
          })),
        ),
      },
      kind: SpanKind.INTERNAL,
    });

    try {
      const { entry, urgency, resolvedBy } = await withSpan(span, () =>
        this.resolveRoute(event),
      );

      span.setAttributes({
        'klex.router.resolved_by': resolvedBy,
        'klex.router.target_short_id': entry.shortId,
        'klex.router.target_urgency': SessionInboxUrgency[urgency],
      });

      // If the session terminated itself, create a replacement.
      if (entry.session.status === 'terminated') {
        this.deps.logger.warn(
          { shortId: entry.shortId },
          'Target session terminated — creating replacement',
        );
        this.sessions.delete(entry.shortId);
        const replacement = await this.createSession();
        replacement.session.restorePendingEvents([]);
        event.urgency = urgency;
        replacement.session.inbox.send(event);
        return;
      }

      event.urgency = urgency;
      entry.session.inbox.send(event);

      this.deps.logger.debug(
        {
          sourceEnv: event.sourceEnv,
          shortId: entry.shortId,
          urgency: SessionInboxUrgency[urgency],
          resolvedBy,
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
   * Core routing logic. Checks rules first, then falls back to the LLM.
   * Returns the target session entry, the urgency to use, and a label
   * identifying which branch resolved the route (for observability).
   */
  private async resolveRoute(event: SessionInboxEvent): Promise<{
    entry: RouterSessionEntry;
    urgency: SessionInboxUrgency;
    resolvedBy: string;
  }> {
    // --- Branch 1: Rule check ---
    // Rules are scoped by sourceEnv — a rule learned from one MCP
    // namespace must not match events from a different namespace.
    for (const entry of this.sessions.values()) {
      if (entry.session.status === 'terminated') continue;
      if (
        entry.routingRule &&
        entry.sourceEnv === event.sourceEnv &&
        matchesRule(event, entry.routingRule)
      ) {
        return {
          entry,
          urgency: event.urgency ?? SessionInboxUrgency.Default,
          resolvedBy: 'rule',
        };
      }
    }

    // --- Branch 2: LLM fallback ---
    const routingModels = this.deps.config.getModelSelection('routing');
    const effectiveModels =
      routingModels.length > 0
        ? routingModels
        : this.deps.config.getModelSelection('chat');

    if (effectiveModels.length > 0) {
      const routingInfo: SessionRoutingInfo[] = [...this.sessions.values()]
        .filter((e) => e.session.status !== 'terminated')
        .map((e) => {
          const si = e.session.getSessionInfo();
          return {
            shortId: e.shortId,
            runtimeState: si.runtimeState,
            activitySummary: si.activitySummary,
          };
        });

      const presetPriority = event.urgency
        ? SessionInboxUrgency[event.urgency]
        : undefined;

      try {
        const decision = await callRoutingLlm({
          logger: this.deps.logger,
          modelProvider: this.deps.modelProvider,
          routingModels: effectiveModels,
          sessions: routingInfo,
          eventMetadata: event.context.metadata,
          sourceEnv: event.sourceEnv,
          contentPreview: buildContentPreview(event.context.content),
          presetPriority,
        });

        if (decision) {
          const urgency = event.urgency ?? mapPriority(decision.priority);

          if (decision.decision === 'new_conversation') {
            const rule = decision.routingRule;

            // Dedup: if an existing session from the same sourceEnv
            // already has the same rule, route to that session instead
            // of creating a duplicate.
            if (Object.keys(rule).length > 0) {
              for (const entry of this.sessions.values()) {
                if (entry.session.status === 'terminated') continue;
                if (
                  entry.sourceEnv === event.sourceEnv &&
                  entry.routingRule &&
                  sameMatch(entry.routingRule, rule)
                ) {
                  return { entry, urgency, resolvedBy: 'rule-dedup' };
                }
              }
            }

            // Validate: the LLM-returned rule must be a subset of the
            // event's metadata. Otherwise the LLM is binding the session
            // to metadata that doesn't belong to this event.
            const ruleIsValid =
              Object.keys(rule).length === 0 || matchesRule(event, rule);
            if (!ruleIsValid) {
              this.deps.logger.warn(
                { rule, sourceEnv: event.sourceEnv },
                'LLM returned a rule that does not match the current event — ignoring rule',
              );
            }
            const effectiveRule = ruleIsValid ? rule : {};

            // Create a new session, await startup, and bind the rule.
            try {
              const newEntry = await this.createAndStartSession(
                event.sourceEnv,
              );
              if (Object.keys(effectiveRule).length > 0) {
                newEntry.routingRule = effectiveRule;
              }
              return { entry: newEntry, urgency, resolvedBy: 'llm' };
            } catch {
              return {
                entry: await this.firstActiveOrCreate(),
                urgency: event.urgency ?? SessionInboxUrgency.Default,
                resolvedBy: 'fallback',
              };
            }
          }

          // decision.decision === 'existing_session'
          const entry = this.sessions.get(decision.sessionId);
          if (entry && entry.session.status !== 'terminated') {
            return { entry, urgency, resolvedBy: 'llm' };
          }

          // Hallucinated session ID — create a new session without a rule.
          this.deps.logger.warn(
            { shortId: decision.sessionId },
            'LLM referenced non-existent session — creating new one',
          );
          try {
            const newEntry = await this.createAndStartSession(event.sourceEnv);
            return { entry: newEntry, urgency, resolvedBy: 'llm-fallback' };
          } catch {
            return {
              entry: await this.firstActiveOrCreate(),
              urgency: event.urgency ?? SessionInboxUrgency.Default,
              resolvedBy: 'fallback',
            };
          }
        }
      } catch {
        // All models threw — fall back.
      }
    }

    // No models or LLM failed — fall back to first active session.
    return {
      entry: await this.firstActiveOrCreate(),
      urgency: event.urgency ?? SessionInboxUrgency.Default,
      resolvedBy: 'fallback',
    };
  }

  /**
   * Creates a new session, sets its sourceEnv, awaits startup, and
   * removes the entry if start fails. Unlike {@link createSession},
   * this method removes the entry on failure so future events don't
   * route to a permanently unready session.
   */
  private async createAndStartSession(
    sourceEnv: string,
  ): Promise<RouterSessionEntry> {
    const entry = this.createSessionSync();
    entry.sourceEnv = sourceEnv;
    try {
      await entry.session.start();
    } catch (error) {
      this.deps.logger.error(
        { error, shortId: entry.shortId },
        'Session start failed — removing entry',
      );
      this.sessions.delete(entry.shortId);
      throw error;
    }
    return entry;
  }

  /**
   * Returns the first active session entry, or creates and starts a
   * new one if none exist.
   */
  private async firstActiveOrCreate(): Promise<RouterSessionEntry> {
    for (const entry of this.sessions.values()) {
      if (entry.session.status !== 'terminated') {
        return entry;
      }
    }
    // No active sessions — create and start one.
    return this.createSession();
  }

  /**
   * Builds a detailed snapshot of all sessions for introspection.
   * Includes router-tracked state (shortId, routingRule) plus session
   * lifecycle info (status, runtimeState, turns, messageCount).
   */
  private buildSessionIntrospection(): object[] {
    const sessions: object[] = [];
    for (const entry of this.sessions.values()) {
      const si = entry.session.getSessionInfo();
      sessions.push({
        shortId: entry.shortId,
        sessionId: si.id,
        routingRule: entry.routingRule,
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
   * Generates a 4-character hex short ID, checking for collisions.
   */
  private generateShortId(): string {
    let id = randomUUID().slice(0, 4);
    let attempts = 0;
    while (this.sessions.has(id)) {
      if (++attempts > 1000) {
        throw new Error(
          'Could not generate a unique short ID after 1000 attempts',
        );
      }
      id = randomUUID().slice(0, 4);
    }
    return id;
  }

  /**
   * Creates a new session entry synchronously (without awaiting start).
   * The session is stored in the map immediately so concurrent calls
   * see it. start() must be awaited separately.
   *
   * The routing rule is initially `null`. It is set by `resolveRoute`
   * after the LLM decides to create a new conversation with a rule.
   */
  private createSessionSync(): RouterSessionEntry {
    const shortId = this.generateShortId();
    const hooks: SessionHooks = {
      onTerminated: (info) => this.handleTerminated(info),
    };
    const session = this.deps.createChatSession(
      hooks,
      this.sessionsScope ?? this.deps.introspection,
      this,
    );
    session.setShortId(shortId);

    const entry: RouterSessionEntry = {
      session,
      shortId,
      routingRule: null,
      sourceEnv: null,
    };
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
   * any pending inbox content. The routing rule dies with the entry —
   * no explicit cleanup needed.
   */
  private async handleTerminated(info: SessionTerminationInfo): Promise<void> {
    if (!this.started) return;
    this.deps.logger.warn(
      {
        sessionId: info.sessionId,
        reason: info.reason,
        pendingEvents: info.pendingEvents.length,
      },
      'Session self-terminated — creating replacement and re-dispatching pending input',
    );

    // Find and remove the terminated session from the map.
    // The routing rule is on the entry and is automatically gone
    // once the entry is removed from the map.
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
