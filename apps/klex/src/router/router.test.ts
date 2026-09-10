import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RootLogger } from '@stagewise/logger';

import type { Config, ModelSelectionEntry } from '@/config';
import type { IntrospectFn, IntrospectionScope } from '@/introspection';
import type { Mcp, McpPushNotification } from '@/mcp';
import type { ProviderModelResolver } from '@/provider-registry';
import { type SessionInboxEvent, SessionInboxUrgency } from '@/session/inbox';
import type { AgentSession, SessionHooks, SessionInfo } from '@/session/types';

import { createRouter, type RouterDependencies } from './router';
import { callRoutingLlm } from './routing-decision';

// --- mocks ---

vi.mock('./routing-decision', () => ({
  callRoutingLlm: vi.fn(),
  matchesRule: vi.fn(
    (
      event: { context: { metadata: Record<string, unknown> } },
      rule: Record<string, string>,
    ) => {
      // Inline flatten + match
      const flat: Record<string, string> = {};
      const flatten = (obj: Record<string, unknown>, prefix = '') => {
        for (const [key, value] of Object.entries(obj)) {
          if (value === null || value === undefined) continue;
          const fullKey = prefix ? `${prefix}.${key}` : key;
          if (typeof value === 'object' && !Array.isArray(value)) {
            flatten(value as Record<string, unknown>, fullKey);
          } else {
            flat[fullKey] = Array.isArray(value)
              ? JSON.stringify(value)
              : String(value);
          }
        }
      };
      flatten(event.context.metadata);
      return Object.entries(rule).every(([key, value]) => flat[key] === value);
    },
  ),
  sameMatch: vi.fn((a: Record<string, string>, b: Record<string, string>) => {
    const ak = Object.keys(a).sort();
    const bk = Object.keys(b).sort();
    return (
      ak.length === bk.length &&
      ak.every((k, i) => k === bk[i] && a[k] === b[k])
    );
  }),
  buildContentPreview: vi.fn(() => ''),
  mapPriority: vi.fn((p: 'low' | 'medium' | 'high') =>
    p === 'high'
      ? SessionInboxUrgency.Critical
      : p === 'low'
        ? SessionInboxUrgency.Deferrable
        : SessionInboxUrgency.Default,
  ),
}));

const { mockRandomUUID, mockSpan } = vi.hoisted(() => ({
  mockRandomUUID: vi.fn(),
  mockSpan: {
    setAttributes: vi.fn(),
    setAttribute: vi.fn(),
    recordException: vi.fn(),
    setStatus: vi.fn(),
    end: vi.fn(),
    spanContext: () => ({ traceId: 't', spanId: 's', traceFlags: 0 }),
  },
}));

vi.mock('@/tracing', () => ({
  tracer: { startSpan: () => mockSpan },
  recordErrorOnSpan: vi.fn(),
  withSpan: (_span: unknown, fn: () => Promise<unknown>) => fn(),
}));

vi.mock('node:crypto', () => ({
  randomUUID: mockRandomUUID,
}));

// --- shared helpers ---

function createIntrospectionMock(): {
  scope: IntrospectionScope;
  getState: (path: string[]) => unknown;
} {
  const children = new Map<
    string,
    ReturnType<typeof createIntrospectionMock>
  >();
  let stateFn: IntrospectFn | null = null;

  const make = (): IntrospectionScope => ({
    path: [],
    introspect: (fn: IntrospectFn) => {
      stateFn = fn;
    },
    child: (id: string) => {
      if (!children.has(id)) {
        children.set(id, createIntrospectionMock());
      }
      return children.get(id)!.scope;
    },
    removeChild: (id: string) => {
      children.delete(id);
    },
  });

  const getState = (path: string[]): unknown => {
    if (path.length === 0) {
      return stateFn ? stateFn() : null;
    }
    const [head, ...rest] = path;
    const child = children.get(head!);
    if (!child) return undefined;
    return child.getState(rest);
  };

  return { scope: make(), getState };
}

function makeSessionInfo(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: `session-${Math.random().toString(36).slice(2, 8)}`,
    status: 'active',
    runtimeState: 'idle',
    model: { id: 'test:model', isFallback: false, fallbackIndex: 0 },
    usage: {
      chat: {
        latest: null,
        total: {
          inputTokens: 0,
          outputTokens: 0,
          inputCacheWriteTokens: 0,
          inputCacheReadTokens: 0,
        },
      },
      extensions: {},
    },
    turns: 0,
    steps: 0,
    messageCount: 0,
    createdAt: new Date().toISOString(),
    shortId: '',
    activitySummary: null,
    ...overrides,
  };
}

function makeMockSession(
  overrides: Partial<AgentSession> & {
    sessionId?: string;
    shortId?: string;
  } = {},
): AgentSession {
  const sessionId =
    overrides.sessionId ?? `session-${Math.random().toString(36).slice(2, 8)}`;
  const info = makeSessionInfo({
    id: sessionId,
    shortId: overrides.shortId ?? '',
    ...overrides,
  });
  return {
    inbox: {
      send: vi.fn(),
      close: vi.fn(),
    },
    status: overrides.status ?? 'active',
    getSessionInfo: vi.fn(() => info),
    start: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    restorePendingEvents: vi.fn(),
    setShortId: vi.fn((id: string) => {
      info.shortId = id;
    }),
    setActivitySummary: vi.fn((summary: string | null) => {
      info.activitySummary = summary;
    }),
    ...overrides,
  } as unknown as AgentSession;
}

// --- routing test deps ---

interface RoutingDecision {
  decision: 'new_conversation' | 'existing_session';
  sessionId: string;
  routingRule: Record<string, string>;
  priority: 'low' | 'medium' | 'high';
}

interface TestDeps {
  deps: RouterDependencies;
  createChatSession: ReturnType<
    typeof vi.fn<
      (
        hooks: SessionHooks,
        introspectionScope: IntrospectionScope,
      ) => AgentSession
    >
  >;
  introspection: ReturnType<typeof createIntrospectionMock>;
}

function makeDeps(
  overrides: Partial<RouterDependencies> & {
    routingModels?: ModelSelectionEntry[];
    chatModels?: ModelSelectionEntry[];
    routingDecision?: RoutingDecision | null;
  } = {},
): TestDeps {
  let shortIdCounter = 0;
  mockRandomUUID.mockImplementation(() => {
    shortIdCounter++;
    return `s${shortIdCounter.toString().padStart(3, '0')}0000000-0000-0000-0000-000000000000`;
  });

  const createChatSession = vi.fn(
    (hooks: SessionHooks, _introspectionScope: IntrospectionScope) => {
      const session = makeMockSession();
      return session;
    },
  );

  const routingModels = overrides.routingModels ?? [];
  const chatModels = overrides.chatModels ?? [];

  const config = {
    get: vi.fn(() => ({
      modelSelection: {
        chat: chatModels,
        compaction: [],
        memory: [],
        routing: routingModels,
      },
    })),
    getModelSelection: vi.fn((purpose: string) =>
      purpose === 'routing'
        ? routingModels
        : purpose === 'chat'
          ? chatModels
          : [],
    ),
  } as unknown as Config;

  const modelProvider = {} as ProviderModelResolver;

  const mcp = {
    onPushNotification: vi.fn(() => () => {}),
  } as unknown as Mcp;

  // Default: callRoutingLlm returns the provided decision or null.
  if (overrides.routingDecision !== undefined) {
    vi.mocked(callRoutingLlm).mockResolvedValue(
      overrides.routingDecision as never,
    );
  }

  const introspectionMock = createIntrospectionMock();

  const deps: RouterDependencies = {
    logging: {
      child: vi.fn(() => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
        fatal: vi.fn(),
      })),
    } as unknown as RootLogger,
    mcp,
    introspection: introspectionMock.scope,
    config,
    modelProvider,
    createChatSession,
    ...overrides,
  } as RouterDependencies;

  return { deps, createChatSession, introspection: introspectionMock };
}

function makeEvent(
  overrides: Partial<{
    sourceEnv: string;
    urgency: SessionInboxUrgency;
    metadata: Record<string, unknown>;
  }> = {},
) {
  return {
    sourceEnv: overrides.sourceEnv ?? 'test',
    urgency: overrides.urgency,
    context: {
      sourceEnv: overrides.sourceEnv ?? 'test',
      metadata: (overrides.metadata ?? {}) as Record<string, never>,
      content: [{ type: 'text' as const, text: 'hello' }],
    },
  };
}

// --- push-notification test setup ---

function setupPushNotificationHarness() {
  const sent: SessionInboxEvent[] = [];
  let listener:
    | ((event: McpPushNotification) => void | Promise<void>)
    | undefined;
  const logging = {
    child: () => ({
      debug: () => undefined,
      error: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      trace: () => undefined,
      fatal: () => undefined,
    }),
  } as unknown as RootLogger;
  const mcp = {
    onPushNotification: (
      next: (event: McpPushNotification) => void | Promise<void>,
    ) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
  } as unknown as Mcp;
  const config = {
    get: vi.fn(() => ({
      modelSelection: { chat: [], compaction: [], memory: [], routing: [] },
    })),
    getModelSelection: vi.fn(() => []),
  } as unknown as Config;
  const modelProvider = {} as ProviderModelResolver;
  const session = {
    status: 'active',
    inbox: { send: (event: SessionInboxEvent) => sent.push(event) },
    start: async () => undefined,
    close: async () => undefined,
    getSessionInfo: vi.fn(() => makeSessionInfo({ shortId: 's001' })),
    setShortId: vi.fn(),
    restorePendingEvents: vi.fn(),
  } as unknown as AgentSession;
  const introspection = createIntrospectionMock();
  // AgentSession requires setActivitySummary on the interface.
  (session as AgentSession).setActivitySummary = vi.fn();
  const router = createRouter({
    logging,
    mcp,
    introspection: introspection.scope,
    config,
    modelProvider,
    createChatSession: () => session,
  });

  return {
    emit(event: McpPushNotification) {
      if (!listener) throw new Error('Router is not listening');
      return listener(event);
    },
    router,
    sent,
  };
}

const envelope = {
  eventId: 'event-1',
  sourceId: 'telegram:77',
  type: 'chat.message.received',
  createdAt: '2026-07-20T10:30:00.000Z',
};

// ---------------------------------------------------------------------------
// Push Notification adaptation tests
// ---------------------------------------------------------------------------

describe('Router Push Notification adaptation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(callRoutingLlm).mockResolvedValue(null as never);
    let counter = 0;
    mockRandomUUID.mockImplementation(() => {
      counter++;
      return `${counter.toString().padStart(4, '0')}000000-0000-0000-0000-000000000000`;
    });
  });

  it('passes through content blocks without validation', async () => {
    const harness = setupPushNotificationHarness();
    await harness.router.start();

    await harness.emit({
      namespace: 'telegram',
      event: {
        ...envelope,
        content: [
          { type: 'text', text: 'first' },
          { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
          { type: 'audio', data: 'YXVkaW8=', mimeType: 'audio/ogg' },
          { type: 'text', text: 'second' },
        ],
        data: { senderId: '40', nested: { z: 2, a: 1 }, chatId: '30' },
      },
    });

    expect(harness.sent).toEqual([
      {
        sourceEnv: 'telegram',
        urgency: SessionInboxUrgency.Default,
        context: {
          sourceEnv: 'telegram',
          metadata: {
            type: 'chat.message.received',
            createdAt: '2026-07-20T10:30:00.000Z',
            senderId: '40',
            chatId: '30',
            nested: { z: 2, a: 1 },
          },
          content: [
            { type: 'text', text: 'first' },
            { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
            { type: 'audio', data: 'YXVkaW8=', mimeType: 'audio/ogg' },
            { type: 'text', text: 'second' },
          ],
        },
      },
    ]);
    await harness.router.close();
  });

  it('awaits session delivery before publication settles', async () => {
    const harness = setupPushNotificationHarness();
    await harness.router.start();
    let release: (() => void) | undefined;
    const delivery = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(harness.router, 'sendInput').mockReturnValue(delivery);

    let settled = false;
    const publication = harness
      .emit({ namespace: 'telegram', event: { ...envelope, content: [] } })
      ?.then(() => {
        settled = true;
      });
    await Promise.resolve();
    expect(settled).toBe(false);

    release?.();
    await publication;
    expect(settled).toBe(true);
    await harness.router.close();
  });

  it('maps resource_link blocks to resource_link content', async () => {
    const harness = setupPushNotificationHarness();
    await harness.router.start();

    await harness.emit({
      namespace: 'telegram',
      event: {
        ...envelope,
        content: [
          {
            type: 'resource_link',
            uri: 'file:///message.txt',
            name: 'message.txt',
            title: 'Message',
            description: 'An embedded text message',
            mimeType: 'text/plain',
            size: 42,
          },
        ],
      },
    });

    expect(harness.sent[0]?.context.content).toEqual([
      {
        type: 'resource_link',
        uri: 'file:///message.txt',
        name: 'message.txt',
        title: 'Message',
        description: 'An embedded text message',
        mimeType: 'text/plain',
        size: 42,
      },
    ]);
    await harness.router.close();
  });

  it('maps embedded resource blocks with text contents', async () => {
    const harness = setupPushNotificationHarness();
    await harness.router.start();

    await harness.emit({
      namespace: 'telegram',
      event: {
        ...envelope,
        content: [
          {
            type: 'resource',
            resource: {
              uri: 'file:///message.txt',
              mimeType: 'text/plain',
              text: 'embedded message',
            },
          },
        ],
      },
    });

    expect(harness.sent[0]?.context.content).toEqual([
      {
        type: 'resource',
        resource: {
          uri: 'file:///message.txt',
          mimeType: 'text/plain',
          text: 'embedded message',
        },
      },
    ]);
    await harness.router.close();
  });

  it('maps embedded resource blocks with blob contents', async () => {
    const harness = setupPushNotificationHarness();
    await harness.router.start();

    await harness.emit({
      namespace: 'telegram',
      event: {
        ...envelope,
        content: [
          {
            type: 'resource',
            resource: {
              uri: 'file:///image.png',
              mimeType: 'image/png',
              blob: 'aW1hZ2U=',
            },
          },
        ],
      },
    });

    expect(harness.sent[0]?.context.content).toEqual([
      {
        type: 'resource',
        resource: {
          uri: 'file:///image.png',
          mimeType: 'image/png',
          blob: 'aW1hZ2U=',
        },
      },
    ]);
    await harness.router.close();
  });

  it('silently omits unknown content block types', async () => {
    const harness = setupPushNotificationHarness();
    await harness.router.start();

    await harness.emit({
      namespace: 'telegram',
      event: {
        ...envelope,
        content: [
          // Simulate a future/unknown block type that the router doesn't know.
          { type: 'unknown_future_type', data: 'x' } as never,
        ],
      },
    });

    expect(harness.sent[0]?.context.content).toEqual([]);
    await harness.router.close();
  });
});

// ---------------------------------------------------------------------------
// Routing logic tests
// ---------------------------------------------------------------------------

describe('Router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(callRoutingLlm).mockResolvedValue(null as never);
  });

  it('start() creates one initial session', async () => {
    const { deps, createChatSession } = makeDeps();
    const router = createRouter(deps);
    await router.start();
    expect(createChatSession).toHaveBeenCalledOnce();
    await router.close();
  });

  it('sendInput with no routing models falls back to chat models for routing', async () => {
    const { deps, createChatSession } = makeDeps({
      routingModels: [],
      chatModels: [
        { providerId: 'chat', modelId: 'model-a' },
        { providerId: 'chat', modelId: 'model-b' },
      ],
      routingDecision: {
        decision: 'existing_session',
        sessionId: 's001',
        routingRule: {},
        priority: 'high',
      },
    });
    const router = createRouter(deps);
    await router.start();

    const event = makeEvent();
    await router.sendInput(event);

    expect(callRoutingLlm).toHaveBeenCalledWith(
      expect.objectContaining({
        routingModels: [
          { providerId: 'chat', modelId: 'model-a' },
          { providerId: 'chat', modelId: 'model-b' },
        ],
      }),
    );
    const session = createChatSession.mock.results[0]!.value as AgentSession;
    expect(session.inbox.send).toHaveBeenCalledWith(event);
    expect(event.urgency).toBe(SessionInboxUrgency.Critical);
    await router.close();
  });

  it('sendInput with no routing models and no chat models routes to first session with Default urgency', async () => {
    const { deps, createChatSession } = makeDeps({
      routingModels: [],
      chatModels: [],
    });
    const router = createRouter(deps);
    await router.start();

    const event = makeEvent();
    await router.sendInput(event);

    const session = createChatSession.mock.results[0]!.value as AgentSession;
    expect(session.inbox.send).toHaveBeenCalledWith(event);
    expect(event.urgency).toBe(SessionInboxUrgency.Default);
    await router.close();
  });

  it('sendInput calls routing LLM and routes to chosen existing session', async () => {
    const { deps, createChatSession } = makeDeps({
      routingModels: [{ providerId: 'test', modelId: 'model' }],
      routingDecision: {
        decision: 'existing_session',
        sessionId: 's001',
        routingRule: {},
        priority: 'high',
      },
    });
    const router = createRouter(deps);
    await router.start();

    // Set the shortId on the initial session to match the decision.
    const initialSession = createChatSession.mock.results[0]!
      .value as AgentSession;
    initialSession.setShortId('s001');
    // Also update the session info to reflect the shortId.
    const info = initialSession.getSessionInfo();
    vi.mocked(initialSession.getSessionInfo).mockReturnValue({
      ...info,
      shortId: 's001',
    });

    const event = makeEvent();
    await router.sendInput(event);

    expect(callRoutingLlm).toHaveBeenCalledOnce();
    expect(initialSession.inbox.send).toHaveBeenCalledWith(event);
    expect(event.urgency).toBe(SessionInboxUrgency.Critical);
    await router.close();
  });

  it('sendInput when LLM chooses new_conversation creates a new session with a routing rule', async () => {
    const { deps, createChatSession } = makeDeps({
      routingModels: [{ providerId: 'test', modelId: 'model' }],
      routingDecision: {
        decision: 'new_conversation',
        sessionId: '',
        routingRule: { chatId: '999' },
        priority: 'medium',
      },
    });
    const router = createRouter(deps);
    await router.start();

    // Fix the initial session's shortId in the map.
    const initialSession = createChatSession.mock.results[0]!
      .value as AgentSession;
    initialSession.setShortId('s001');
    const info = initialSession.getSessionInfo();
    vi.mocked(initialSession.getSessionInfo).mockReturnValue({
      ...info,
      shortId: 's001',
    });

    const event = makeEvent({ metadata: { chatId: '999' } });
    await router.sendInput(event);

    // Two sessions: initial + new
    expect(createChatSession).toHaveBeenCalledTimes(2);
    const newSession = createChatSession.mock.results[1]!.value as AgentSession;
    expect(newSession.inbox.send).toHaveBeenCalledWith(event);
    await router.close();
  });

  it('sendInput when LLM returns new_conversation with empty routingRule creates session without rule', async () => {
    const { deps, createChatSession } = makeDeps({
      routingModels: [{ providerId: 'test', modelId: 'model' }],
      routingDecision: {
        decision: 'new_conversation',
        sessionId: '',
        routingRule: {},
        priority: 'medium',
      },
    });
    const router = createRouter(deps);
    await router.start();

    const initialSession = createChatSession.mock.results[0]!
      .value as AgentSession;
    initialSession.setShortId('s001');
    const info = initialSession.getSessionInfo();
    vi.mocked(initialSession.getSessionInfo).mockReturnValue({
      ...info,
      shortId: 's001',
    });

    const event = makeEvent();
    await router.sendInput(event);

    // Two sessions: initial + new (no rule bound)
    expect(createChatSession).toHaveBeenCalledTimes(2);
    const newSession = createChatSession.mock.results[1]!.value as AgentSession;
    expect(newSession.inbox.send).toHaveBeenCalledWith(event);
    await router.close();
  });

  it('sendInput when LLM chooses existing_session with invalid ID creates new session', async () => {
    const { deps, createChatSession } = makeDeps({
      routingModels: [{ providerId: 'test', modelId: 'model' }],
      routingDecision: {
        decision: 'existing_session',
        sessionId: 'xxxx',
        routingRule: {},
        priority: 'low',
      },
    });
    const router = createRouter(deps);
    await router.start();

    // Fix the initial session's shortId.
    const initialSession = createChatSession.mock.results[0]!
      .value as AgentSession;
    initialSession.setShortId('s001');
    const info = initialSession.getSessionInfo();
    vi.mocked(initialSession.getSessionInfo).mockReturnValue({
      ...info,
      shortId: 's001',
    });

    const event = makeEvent();
    await router.sendInput(event);

    // Initial + new session (because 'xxxx' doesn't match)
    expect(createChatSession).toHaveBeenCalledTimes(2);
    const newSession = createChatSession.mock.results[1]!.value as AgentSession;
    expect(newSession.inbox.send).toHaveBeenCalledWith(event);
    expect(event.urgency).toBe(SessionInboxUrgency.Deferrable);
    await router.close();
  });

  it('sendInput when all routing models fail falls back to first session', async () => {
    const { deps, createChatSession } = makeDeps({
      routingModels: [{ providerId: 'test', modelId: 'model' }],
      routingDecision: null,
    });
    const router = createRouter(deps);
    await router.start();

    const event = makeEvent();
    await router.sendInput(event);

    const session = createChatSession.mock.results[0]!.value as AgentSession;
    expect(session.inbox.send).toHaveBeenCalledWith(event);
    expect(event.urgency).toBe(SessionInboxUrgency.Default);
    await router.close();
  });

  it('preset urgency overrides LLM decision urgency', async () => {
    const { deps, createChatSession } = makeDeps({
      routingModels: [{ providerId: 'test', modelId: 'model' }],
      routingDecision: {
        decision: 'existing_session',
        sessionId: 's001',
        routingRule: {},
        priority: 'low',
      },
    });
    const router = createRouter(deps);
    await router.start();

    const session = createChatSession.mock.results[0]!.value as AgentSession;
    session.setShortId('s001');
    const info = session.getSessionInfo();
    vi.mocked(session.getSessionInfo).mockReturnValue({
      ...info,
      shortId: 's001',
    });

    const event = makeEvent({ urgency: SessionInboxUrgency.Critical });
    await router.sendInput(event);

    // LLM said 'low' but event had preset Critical — Critical wins.
    expect(event.urgency).toBe(SessionInboxUrgency.Critical);
    await router.close();
  });

  it('preset urgency is used when all routing models fail', async () => {
    const { deps, createChatSession } = makeDeps({
      routingModels: [{ providerId: 'test', modelId: 'model' }],
      routingDecision: null,
    });
    const router = createRouter(deps);
    await router.start();

    const event = makeEvent({ urgency: SessionInboxUrgency.Critical });
    await router.sendInput(event);

    const session = createChatSession.mock.results[0]!.value as AgentSession;
    expect(session.inbox.send).toHaveBeenCalledWith(event);
    expect(event.urgency).toBe(SessionInboxUrgency.Critical);
    await router.close();
  });

  it('getSessions() returns all sessions with shortId', async () => {
    const { deps, createChatSession } = makeDeps();
    const router = createRouter(deps);
    await router.start();

    const session = createChatSession.mock.results[0]!.value as AgentSession;
    session.setShortId('s001');
    const info = session.getSessionInfo();
    vi.mocked(session.getSessionInfo).mockReturnValue({
      ...info,
      shortId: 's001',
    });

    const sessions = router.getSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.shortId).toBe('s001');
    await router.close();
  });

  it('introspection exposes router state with session details', async () => {
    const { deps, createChatSession, introspection } = makeDeps();
    const router = createRouter(deps);
    await router.start();

    const session = createChatSession.mock.results[0]!.value as AgentSession;
    session.setShortId('s001');
    const info = session.getSessionInfo();
    vi.mocked(session.getSessionInfo).mockReturnValue({
      ...info,
      shortId: 's001',
      turns: 3,
      messageCount: 7,
    });

    const state = introspection.getState(['router']) as {
      started: boolean;
      sessionCount: number;
      sessions: Array<Record<string, unknown>>;
    };

    expect(state.started).toBe(true);
    expect(state.sessionCount).toBe(1);
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0]!.shortId).toBe('s001');
    expect(state.sessions[0]!.status).toBe('active');
    expect(state.sessions[0]!.runtimeState).toBe('idle');
    expect(state.sessions[0]!.turns).toBe(3);
    expect(state.sessions[0]!.messageCount).toBe(7);
    expect(state.sessions[0]!.routingRule).toBeNull();

    await router.close();
  });

  it('handleTerminated removes the session and creates a replacement', async () => {
    const { deps, createChatSession } = makeDeps();
    const router = createRouter(deps);
    await router.start();

    const initialSession = createChatSession.mock.results[0]!
      .value as AgentSession;
    const initialInfo = initialSession.getSessionInfo();
    vi.mocked(initialSession.getSessionInfo).mockReturnValue({
      ...initialInfo,
      shortId: 's001',
    });

    // Simulate termination by calling the onTerminated hook.
    const hooks = createChatSession.mock.calls[0]![0] as SessionHooks;
    await hooks.onTerminated?.({
      sessionId: initialInfo.id,
      reason: 'fatal error',
      pendingEvents: [],
    });

    // A replacement session should have been created.
    expect(createChatSession).toHaveBeenCalledTimes(2);
    const replacement = createChatSession.mock.results[1]!
      .value as AgentSession;
    expect(replacement.start).toHaveBeenCalled();

    // getSessions should return the replacement, not the terminated one.
    const sessions = router.getSessions();
    // The replacement session is the only one in the map.
    expect(sessions).toHaveLength(1);

    await router.close();
  });

  it('urgency mapping works for low, medium, and high routing priorities', async () => {
    // Test low priority
    const depsLow = makeDeps({
      routingModels: [{ providerId: 'test', modelId: 'model' }],
      routingDecision: {
        decision: 'existing_session',
        sessionId: 's001',
        routingRule: {},
        priority: 'low',
      },
    });
    const routerLow = createRouter(depsLow.deps);
    await routerLow.start();
    const sessionLow = depsLow.createChatSession.mock.results[0]!
      .value as AgentSession;
    sessionLow.setShortId('s001');
    const infoLow = sessionLow.getSessionInfo();
    vi.mocked(sessionLow.getSessionInfo).mockReturnValue({
      ...infoLow,
      shortId: 's001',
    });
    const eventLow = makeEvent();
    await routerLow.sendInput(eventLow);
    expect(eventLow.urgency).toBe(SessionInboxUrgency.Deferrable);
    await routerLow.close();

    // Reset mock for medium test
    vi.clearAllMocks();
    vi.mocked(callRoutingLlm).mockResolvedValue({
      decision: 'existing_session',
      sessionId: 's001',
      routingRule: {},
      priority: 'medium',
    } as never);

    // Test medium priority
    const depsMed = makeDeps({
      routingModels: [{ providerId: 'test', modelId: 'model' }],
    });
    const routerMed = createRouter(depsMed.deps);
    await routerMed.start();
    const sessionMed = depsMed.createChatSession.mock.results[0]!
      .value as AgentSession;
    sessionMed.setShortId('s001');
    const infoMed = sessionMed.getSessionInfo();
    vi.mocked(sessionMed.getSessionInfo).mockReturnValue({
      ...infoMed,
      shortId: 's001',
    });
    const eventMed = makeEvent();
    await routerMed.sendInput(eventMed);
    expect(eventMed.urgency).toBe(SessionInboxUrgency.Default);
    await routerMed.close();

    // Reset mock for high test
    vi.clearAllMocks();
    vi.mocked(callRoutingLlm).mockResolvedValue({
      decision: 'existing_session',
      sessionId: 's001',
      routingRule: {},
      priority: 'high',
    } as never);

    // Test high priority
    const depsHigh = makeDeps({
      routingModels: [{ providerId: 'test', modelId: 'model' }],
    });
    const routerHigh = createRouter(depsHigh.deps);
    await routerHigh.start();
    const sessionHigh = depsHigh.createChatSession.mock.results[0]!
      .value as AgentSession;
    sessionHigh.setShortId('s001');
    const infoHigh = sessionHigh.getSessionInfo();
    vi.mocked(sessionHigh.getSessionInfo).mockReturnValue({
      ...infoHigh,
      shortId: 's001',
    });
    const eventHigh = makeEvent();
    await routerHigh.sendInput(eventHigh);
    expect(eventHigh.urgency).toBe(SessionInboxUrgency.Critical);
    await routerHigh.close();
  });

  it('passes activitySummary from session info to routing LLM', async () => {
    const { deps, createChatSession } = makeDeps({
      routingModels: [{ providerId: 'test', modelId: 'model' }],
      routingDecision: {
        decision: 'existing_session',
        sessionId: 's001',
        routingRule: {},
        priority: 'medium',
      },
    });
    const router = createRouter(deps);
    await router.start();

    const session = createChatSession.mock.results[0]!.value as AgentSession;
    session.setShortId('s001');
    const info = session.getSessionInfo();
    vi.mocked(session.getSessionInfo).mockReturnValue({
      ...info,
      shortId: 's001',
      activitySummary:
        'Reviewing PR #42 in klex-agent; notified chat 999 on Telegram',
    });

    // Event with no routing-relevant metadata so it reaches the LLM.
    const event = makeEvent();
    await router.sendInput(event);

    const lastCall = vi.mocked(callRoutingLlm).mock.calls.at(-1)?.[0];
    expect(lastCall?.sessions[0]?.activitySummary).toBe(
      'Reviewing PR #42 in klex-agent; notified chat 999 on Telegram',
    );

    await router.close();
  });

  // -------------------------------------------------------------------------
  // Rule-based routing tests
  // -------------------------------------------------------------------------

  it('routes events with matching rule to the same session without calling LLM', async () => {
    const { deps, createChatSession } = makeDeps({
      routingModels: [{ providerId: 'test', modelId: 'model' }],
      routingDecision: {
        decision: 'new_conversation',
        sessionId: '',
        routingRule: { chatId: '123' },
        priority: 'medium',
      },
    });
    const router = createRouter(deps);
    await router.start();

    const initialSession = createChatSession.mock.results[0]!
      .value as AgentSession;
    initialSession.setShortId('s001');
    const info = initialSession.getSessionInfo();
    vi.mocked(initialSession.getSessionInfo).mockReturnValue({
      ...info,
      shortId: 's001',
    });

    // First event with chatId metadata — LLM creates a new session with rule.
    const event1 = makeEvent({ metadata: { chatId: '123' } });
    await router.sendInput(event1);

    // Two sessions: initial + new (created by LLM with rule { chatId: '123' }).
    expect(createChatSession).toHaveBeenCalledTimes(2);
    const newSession = createChatSession.mock.results[1]!.value as AgentSession;
    expect(newSession.inbox.send).toHaveBeenCalledWith(event1);

    // Second event with same chatId — should route via rule, no LLM call.
    const callCountBefore = vi.mocked(callRoutingLlm).mock.calls.length;
    const event2 = makeEvent({ metadata: { chatId: '123' } });
    await router.sendInput(event2);

    // No additional session created.
    expect(createChatSession).toHaveBeenCalledTimes(2);
    expect(newSession.inbox.send).toHaveBeenCalledWith(event2);
    // LLM was NOT called for the second event (rule matched).
    expect(vi.mocked(callRoutingLlm).mock.calls.length).toBe(callCountBefore);

    await router.close();
  });

  it('rule match ignores extra metadata keys', async () => {
    const { deps, createChatSession } = makeDeps({
      routingModels: [{ providerId: 'test', modelId: 'model' }],
      routingDecision: {
        decision: 'new_conversation',
        sessionId: '',
        routingRule: { chatId: '123' },
        priority: 'medium',
      },
    });
    const router = createRouter(deps);
    await router.start();

    const initialSession = createChatSession.mock.results[0]!
      .value as AgentSession;
    initialSession.setShortId('s001');
    const info = initialSession.getSessionInfo();
    vi.mocked(initialSession.getSessionInfo).mockReturnValue({
      ...info,
      shortId: 's001',
    });

    // First event: LLM creates session with rule { chatId: '123' }.
    const event1 = makeEvent({ metadata: { chatId: '123' } });
    await router.sendInput(event1);

    // Second event has extra keys — rule should still match.
    const event2 = makeEvent({
      metadata: { chatId: '123', senderId: 'u1', extra: 'x' },
    });
    await router.sendInput(event2);

    // No additional session created — rule matched.
    expect(createChatSession).toHaveBeenCalledTimes(2);
    const newSession = createChatSession.mock.results[1]!.value as AgentSession;
    expect(newSession.inbox.send).toHaveBeenCalledWith(event2);

    await router.close();
  });

  it('does not call LLM when a rule matches', async () => {
    const { deps, createChatSession } = makeDeps({
      routingModels: [{ providerId: 'test', modelId: 'model' }],
      routingDecision: {
        decision: 'new_conversation',
        sessionId: '',
        routingRule: { threadId: 't1' },
        priority: 'medium',
      },
    });
    const router = createRouter(deps);
    await router.start();

    const initialSession = createChatSession.mock.results[0]!
      .value as AgentSession;
    initialSession.setShortId('s001');
    const info = initialSession.getSessionInfo();
    vi.mocked(initialSession.getSessionInfo).mockReturnValue({
      ...info,
      shortId: 's001',
    });

    // First event: LLM creates session with rule.
    const event1 = makeEvent({ metadata: { threadId: 't1' } });
    await router.sendInput(event1);

    // Reset call count.
    vi.mocked(callRoutingLlm).mockClear();

    // Second event matches the rule.
    const event2 = makeEvent({ metadata: { threadId: 't1' } });
    await router.sendInput(event2);

    expect(callRoutingLlm).not.toHaveBeenCalled();

    await router.close();
  });

  it('dedup: LLM returns new_conversation but rule already exists — routes to existing session', async () => {
    const { deps, createChatSession } = makeDeps({
      routingModels: [{ providerId: 'test', modelId: 'model' }],
      routingDecision: {
        decision: 'new_conversation',
        sessionId: '',
        routingRule: { chatId: '123' },
        priority: 'medium',
      },
    });
    const router = createRouter(deps);
    await router.start();

    const initialSession = createChatSession.mock.results[0]!
      .value as AgentSession;
    initialSession.setShortId('s001');
    const info = initialSession.getSessionInfo();
    vi.mocked(initialSession.getSessionInfo).mockReturnValue({
      ...info,
      shortId: 's001',
    });

    // First event: LLM creates session with rule { chatId: '123' }.
    const event1 = makeEvent({ metadata: { chatId: '123' } });
    await router.sendInput(event1);

    expect(createChatSession).toHaveBeenCalledTimes(2);
    const ruleSession = createChatSession.mock.results[1]!
      .value as AgentSession;

    // event2 has metadata that does NOT match any existing rule,
    // so it reaches the LLM. The LLM returns new_conversation with
    // the same rule { chatId: '123' } — dedup should route to the
    // existing rule session instead of creating a duplicate.
    const event2 = makeEvent({ metadata: { senderId: 'u9' } });
    await router.sendInput(event2);

    // No additional session created — dedup kicked in.
    expect(createChatSession).toHaveBeenCalledTimes(2);
    expect(ruleSession.inbox.send).toHaveBeenCalledWith(event2);

    await router.close();
  });

  it('rule is removed when session terminates', async () => {
    const { deps, createChatSession } = makeDeps({
      routingModels: [{ providerId: 'test', modelId: 'model' }],
      routingDecision: {
        decision: 'new_conversation',
        sessionId: '',
        routingRule: { chatId: '123' },
        priority: 'medium',
      },
    });
    const router = createRouter(deps);
    await router.start();

    const initialSession = createChatSession.mock.results[0]!
      .value as AgentSession;
    initialSession.setShortId('s001');
    const info = initialSession.getSessionInfo();
    vi.mocked(initialSession.getSessionInfo).mockReturnValue({
      ...info,
      shortId: 's001',
    });

    // First event: LLM creates session with rule.
    const event1 = makeEvent({ metadata: { chatId: '123' } });
    await router.sendInput(event1);

    expect(createChatSession).toHaveBeenCalledTimes(2);
    const ruleSession = createChatSession.mock.results[1]!
      .value as AgentSession;
    const ruleInfo = ruleSession.getSessionInfo();
    vi.mocked(ruleSession.getSessionInfo).mockReturnValue({
      ...ruleInfo,
      shortId: 's002',
    });

    // Terminate the rule session.
    const hooks = createChatSession.mock.calls[1]![0] as SessionHooks;
    await hooks.onTerminated?.({
      sessionId: ruleInfo.id,
      reason: 'fatal error',
      pendingEvents: [],
    });

    // A replacement session should have been created (3 total).
    expect(createChatSession).toHaveBeenCalledTimes(3);

    // Now send event with same chatId — rule no longer matches (session gone).
    // LLM should be called.
    vi.mocked(callRoutingLlm).mockClear();
    const event2 = makeEvent({ metadata: { chatId: '123' } });
    await router.sendInput(event2);

    // LLM was called because the rule session is gone.
    expect(callRoutingLlm).toHaveBeenCalled();

    await router.close();
  });

  it('events with no routing metadata fall through to LLM', async () => {
    const { deps, createChatSession } = makeDeps({
      routingModels: [{ providerId: 'test', modelId: 'model' }],
      routingDecision: {
        decision: 'new_conversation',
        sessionId: '',
        routingRule: {},
        priority: 'medium',
      },
    });
    const router = createRouter(deps);
    await router.start();

    // Event with empty metadata — no rule to match, falls through to LLM.
    const event = makeEvent();
    event.context.metadata = {};
    await router.sendInput(event);

    // LLM was called.
    expect(callRoutingLlm).toHaveBeenCalledOnce();

    await router.close();
  });

  it('recovers routing queue after a dispatch failure', async () => {
    const { deps, createChatSession } = makeDeps({
      routingModels: [],
      chatModels: [],
    });
    const router = createRouter(deps);
    await router.start();

    const session = createChatSession.mock.results[0]!.value as AgentSession;
    session.setShortId('s001');
    const info = session.getSessionInfo();
    vi.mocked(session.getSessionInfo).mockReturnValue({
      ...info,
      shortId: 's001',
    });

    // First event: make inbox.send throw to simulate a closed inbox.
    vi.mocked(session.inbox.send).mockImplementationOnce(() => {
      throw new Error('inbox closed');
    });
    const event1 = makeEvent();
    await router.sendInput(event1); // Should not throw

    // Second event: inbox.send works again — queue should have recovered.
    const event2 = makeEvent();
    await router.sendInput(event2);
    expect(session.inbox.send).toHaveBeenCalledWith(event2);

    await router.close();
  });

  it('does not match rules across different sourceEnv', async () => {
    const { deps, createChatSession } = makeDeps({
      routingModels: [{ providerId: 'test', modelId: 'model' }],
      routingDecision: {
        decision: 'new_conversation',
        sessionId: '',
        routingRule: { chatId: '123' },
        priority: 'medium',
      },
    });
    const router = createRouter(deps);
    await router.start();

    const initialSession = createChatSession.mock.results[0]!
      .value as AgentSession;
    initialSession.setShortId('s001');
    const info = initialSession.getSessionInfo();
    vi.mocked(initialSession.getSessionInfo).mockReturnValue({
      ...info,
      shortId: 's001',
    });

    // Event from 'telegram' — LLM creates session with rule { chatId: '123' }.
    const event1 = makeEvent({
      sourceEnv: 'telegram',
      metadata: { chatId: '123' },
    });
    await router.sendInput(event1);

    expect(createChatSession).toHaveBeenCalledTimes(2);

    // Event from 'slack' with same chatId — should NOT match the telegram rule.
    vi.mocked(callRoutingLlm).mockClear();
    const event2 = makeEvent({
      sourceEnv: 'slack',
      metadata: { chatId: '123' },
    });
    await router.sendInput(event2);

    // LLM was called because sourceEnv doesn't match.
    expect(callRoutingLlm).toHaveBeenCalled();

    await router.close();
  });

  it('ignores LLM-returned rule that does not match event metadata', async () => {
    const { deps, createChatSession } = makeDeps({
      routingModels: [{ providerId: 'test', modelId: 'model' }],
      routingDecision: {
        decision: 'new_conversation',
        sessionId: '',
        routingRule: { chatId: '999' },
        priority: 'medium',
      },
    });
    const router = createRouter(deps);
    await router.start();

    const initialSession = createChatSession.mock.results[0]!
      .value as AgentSession;
    initialSession.setShortId('s001');
    const info = initialSession.getSessionInfo();
    vi.mocked(initialSession.getSessionInfo).mockReturnValue({
      ...info,
      shortId: 's001',
    });

    // Event has senderId, not chatId — LLM returns rule with chatId
    // which doesn't match the event metadata. Rule should be ignored.
    const event = makeEvent({ metadata: { senderId: 'u1' } });
    await router.sendInput(event);

    // Two sessions: initial + new (created without rule because rule was invalid)
    expect(createChatSession).toHaveBeenCalledTimes(2);
    const newSession = createChatSession.mock.results[1]!.value as AgentSession;
    expect(newSession.inbox.send).toHaveBeenCalledWith(event);

    // Verify no rule was bound: a subsequent event with senderId: 'u1'
    // should NOT match via rule and should call the LLM.
    vi.mocked(callRoutingLlm).mockClear();
    const event2 = makeEvent({ metadata: { senderId: 'u1' } });
    await router.sendInput(event2);
    expect(callRoutingLlm).toHaveBeenCalled();

    await router.close();
  });

  it('supports close followed by start without leaking scopes', async () => {
    const { deps } = makeDeps();
    const router = createRouter(deps);

    await router.start();
    await router.close();
    await router.start();

    await router.close();
  });
});
