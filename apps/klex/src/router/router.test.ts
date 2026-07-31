import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RootLogger } from '@stagewise/logger';

import type { Config, ModelId } from '@/config';
import type { IntrospectionScope } from '@/introspection';
import type { Mcp, McpPushNotification } from '@/mcp';
import type { ModelProvider } from '@/model-provider';
import { type SessionInboxEvent, SessionInboxPriority } from '@/session/inbox';
import type {
  AgentSession,
  SessionHooks,
  SessionInfo,
} from '@/session/types';

import { createRouter, type RouterDependencies } from './router';
import { callRoutingLlm } from './routing-decision';

// --- mocks ---

vi.mock('./routing-decision', () => ({
  callRoutingLlm: vi.fn(),
}));

const { mockRandomUUID } = vi.hoisted(() => ({
  mockRandomUUID: vi.fn(),
}));

vi.mock('node:crypto', () => ({
  randomUUID: mockRandomUUID,
}));

// --- shared helpers ---

function createIntrospectionMock(): IntrospectionScope {
  const make = (): IntrospectionScope => ({
    path: [],
    introspect: () => undefined,
    child: () => make(),
    removeChild: () => undefined,
  });
  return make();
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
    summary: null,
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
    setSummary: vi.fn((s: string) => {
      info.summary = s;
    }),
    ...overrides,
  } as unknown as AgentSession;
}

// --- routing test deps ---

interface TestDeps {
  deps: RouterDependencies;
  createChatSession: ReturnType<
    typeof vi.fn<
      (hooks: SessionHooks, introspectionScope: IntrospectionScope) => AgentSession
    >
  >;
}

function makeDeps(
  overrides: Partial<RouterDependencies> & {
    routingModels?: ModelId[];
    chatModels?: ModelId[];
    routingDecision?: Record<string, unknown> | null;
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
      purpose === 'routing' ? routingModels : purpose === 'chat' ? chatModels : [],
    ),
  } as unknown as Config;

  const modelProvider = {} as ModelProvider;

  const mcp = {
    onPushNotification: vi.fn(() => () => {}),
  } as unknown as Mcp;

  // Default: callRoutingLlm returns the provided decision or null.
  if (overrides.routingDecision !== undefined) {
    vi.mocked(callRoutingLlm).mockResolvedValue(
      overrides.routingDecision as never,
    );
  }

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
    introspection: createIntrospectionMock(),
    config,
    modelProvider,
    createChatSession,
    ...overrides,
  } as RouterDependencies;

  return { deps, createChatSession };
}

function makeEvent(
  overrides: Partial<{
    sourceEnv: string;
    priority: SessionInboxPriority;
  }> = {},
) {
  return {
    sourceEnv: overrides.sourceEnv ?? 'test',
    priority: overrides.priority ?? SessionInboxPriority.Medium,
    context: {
      sourceEnv: overrides.sourceEnv ?? 'test',
      metadata: {},
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
  const modelProvider = {} as ModelProvider;
  const session = {
    status: 'active',
    inbox: { send: (event: SessionInboxEvent) => sent.push(event) },
    start: async () => undefined,
    close: async () => undefined,
    getSessionInfo: vi.fn(() =>
      makeSessionInfo({ shortId: 's001' }),
    ),
    setShortId: vi.fn(),
    setSummary: vi.fn(),
    restorePendingEvents: vi.fn(),
  } as unknown as AgentSession;
  const router = createRouter({
    logging,
    mcp,
    introspection: createIntrospectionMock(),
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
        priority: SessionInboxPriority.Medium,
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
      chatModels: ['chat:model-a', 'chat:model-b'],
      routingDecision: {
        sessionChoice: 'existing',
        sessionId: 's001',
        priority: 'high',
        summary: 'Updated summary',
      },
    });
    const router = createRouter(deps);
    await router.start();

    const event = makeEvent();
    await router.sendInput(event);

    expect(callRoutingLlm).toHaveBeenCalledWith(
      expect.objectContaining({
        routingModels: ['chat:model-a', 'chat:model-b'],
      }),
    );
    const session = createChatSession.mock.results[0]!.value as AgentSession;
    expect(session.inbox.send).toHaveBeenCalledWith(event);
    expect(event.priority).toBe(SessionInboxPriority.High);
    await router.close();
  });

  it('sendInput with no routing models and no chat models routes to first session with Medium priority', async () => {
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
    expect(event.priority).toBe(SessionInboxPriority.Medium);
    await router.close();
  });

  it('sendInput calls routing LLM and routes to chosen existing session', async () => {
    const { deps, createChatSession } = makeDeps({
      routingModels: ['test:model'],
      routingDecision: {
        sessionChoice: 'existing',
        sessionId: 's001',
        priority: 'high',
        summary: 'Now handling urgent request',
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
    expect(event.priority).toBe(SessionInboxPriority.High);
    expect(initialSession.setSummary).toHaveBeenCalledWith(
      'Now handling urgent request',
    );
    await router.close();
  });

  it('sendInput when LLM chooses "new" creates a new session', async () => {
    const { deps, createChatSession } = makeDeps({
      routingModels: ['test:model'],
      routingDecision: {
        sessionChoice: 'new',
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

    const event = makeEvent();
    await router.sendInput(event);

    // Two sessions: initial + new
    expect(createChatSession).toHaveBeenCalledTimes(2);
    const newSession = createChatSession.mock.results[1]!.value as AgentSession;
    expect(newSession.inbox.send).toHaveBeenCalledWith(event);
    await router.close();
  });

  it('sendInput when LLM chooses "existing" with invalid ID creates new session', async () => {
    const { deps, createChatSession } = makeDeps({
      routingModels: ['test:model'],
      routingDecision: {
        sessionChoice: 'existing',
        sessionId: 'xxxx',
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
    expect(event.priority).toBe(SessionInboxPriority.Low);
    await router.close();
  });

  it('sendInput when all routing models fail falls back to first session', async () => {
    const { deps, createChatSession } = makeDeps({
      routingModels: ['test:model'],
      routingDecision: null,
    });
    const router = createRouter(deps);
    await router.start();

    const event = makeEvent();
    await router.sendInput(event);

    const session = createChatSession.mock.results[0]!.value as AgentSession;
    expect(session.inbox.send).toHaveBeenCalledWith(event);
    expect(event.priority).toBe(SessionInboxPriority.Medium);
    await router.close();
  });

  it('getSessions() returns all sessions with shortId and summary', async () => {
    const { deps, createChatSession } = makeDeps();
    const router = createRouter(deps);
    await router.start();

    const session = createChatSession.mock.results[0]!.value as AgentSession;
    session.setShortId('s001');
    const info = session.getSessionInfo();
    vi.mocked(session.getSessionInfo).mockReturnValue({
      ...info,
      shortId: 's001',
      summary: 'Test summary',
    });

    const sessions = router.getSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.shortId).toBe('s001');
    expect(sessions[0]!.summary).toBe('Test summary');
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

  it('priority mapping works for low, medium, and high', async () => {
    // Test low priority
    const depsLow = makeDeps({
      routingModels: ['test:model'],
      routingDecision: {
        sessionChoice: 'existing',
        sessionId: 's001',
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
    expect(eventLow.priority).toBe(SessionInboxPriority.Low);
    await routerLow.close();

    // Reset mock for medium test
    vi.clearAllMocks();
    vi.mocked(callRoutingLlm).mockResolvedValue({
      sessionChoice: 'existing',
      sessionId: 's001',
      priority: 'medium',
    } as never);

    // Test medium priority
    const depsMed = makeDeps({
      routingModels: ['test:model'],
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
    expect(eventMed.priority).toBe(SessionInboxPriority.Medium);
    await routerMed.close();
  });

  it('summary update flow calls session.setSummary', async () => {
    const { deps, createChatSession } = makeDeps({
      routingModels: ['test:model'],
      routingDecision: {
        sessionChoice: 'existing',
        sessionId: 's001',
        priority: 'medium',
        summary: 'Updated activity summary',
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

    await router.sendInput(makeEvent());

    expect(session.setSummary).toHaveBeenCalledWith('Updated activity summary');
    await router.close();
  });
});
