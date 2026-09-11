import { describe, expect, it, vi } from 'vitest';

import type { RootLogger } from '@stagewise/logger';

import type { IntrospectionScope } from '@/introspection';
import type { Mcp, McpPushNotification } from '@/mcp';
import { type SessionInboxEvent, SessionInboxUrgency } from '@/session/inbox';
import type {
  InteractionLease,
  InteractionLeaseClosure,
  InteractionLeaseRequest,
} from '@/session/interaction';
import type {
  AgentSession,
  SessionHooks,
  SessionInfo,
  SessionStatus,
} from '@/session/types';

import { createRouter, RouterUnavailableError } from './router';

function createIntrospectionMock(): IntrospectionScope {
  const make = (path: string[]): IntrospectionScope => {
    const children = new Set<string>();
    return {
      path,
      introspect: () => undefined,
      child: (id) => {
        if (children.has(id)) throw new Error(`Duplicate child: ${id}`);
        children.add(id);
        return make([...path, id]);
      },
      removeChild: (id) => {
        children.delete(id);
      },
    };
  };
  return make([]);
}

function setup() {
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
  const session = {
    status: 'active',
    inbox: { send: (event: SessionInboxEvent) => sent.push(event) },
    start: async () => undefined,
    close: async () => undefined,
  } as unknown as AgentSession;
  const introspection = createIntrospectionMock();
  let createdSessionId: string | undefined;
  const router = createRouter({
    logging,
    mcp,
    introspection,
    createChatSession: (_hooks, _scope, _router, sessionId) => {
      createdSessionId = sessionId;
      return session;
    },
  });

  return {
    emit(event: McpPushNotification) {
      if (!listener) throw new Error('Router is not listening');
      return listener(event);
    },
    router,
    sent,
    get createdSessionId() {
      return createdSessionId;
    },
  };
}

// --- lease harness ---

function makeSessionInfo(id: string): SessionInfo {
  return {
    id,
    status: 'active',
    runtimeState: 'idle',
    model: { id: null, isFallback: false, fallbackIndex: 0 },
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
    createdAt: '2026-07-20T10:30:00.000Z',
  };
}

/** Minimal lease double — only identity and closure are exercised here. */
class FakeLease implements InteractionLease {
  public readonly mode = 'realtime' as const;
  private resolveClosed!: (closure: InteractionLeaseClosure) => void;
  public readonly closed = new Promise<InteractionLeaseClosure>((resolve) => {
    this.resolveClosed = resolve;
  });

  constructor(
    public readonly id: string,
    public readonly sessionId: string,
  ) {}

  public readonly updates: AsyncIterable<never> = {
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.resolve({ done: true as const, value: undefined }),
    }),
  };

  bootstrap(): never {
    throw new Error('not used in router tests');
  }
  acknowledgeUpdate(): void {}
  executeTool(): never {
    throw new Error('not used in router tests');
  }
  async commit(): Promise<void> {}
  async release(reason?: string): Promise<void> {
    this.resolveClosed({ type: 'released', ...(reason ? { reason } : {}) });
  }
  revoke(): void {
    this.resolveClosed({ type: 'revoked', reason: 'primary-session-closed' });
  }
}

class FakeSession implements AgentSession {
  public status: SessionStatus = 'active';
  public readonly sent: SessionInboxEvent[] = [];
  public readonly leases: FakeLease[] = [];
  public leaseRequests = 0;
  public closeCount = 0;

  constructor(
    public readonly id: string,
    private readonly gate?: Promise<void>,
  ) {}

  public readonly inbox = {
    send: (event: SessionInboxEvent) => {
      this.sent.push(event);
    },
    close: () => undefined,
  };

  async start(): Promise<void> {
    await this.gate;
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    this.status = 'terminated';
    for (const lease of this.leases) lease.revoke();
  }

  restorePendingEvents(events: SessionInboxEvent[]): void {
    this.sent.push(...events);
  }

  getSessionInfo(): SessionInfo {
    return makeSessionInfo(this.id);
  }

  async acquireInteractionLease(
    _request: InteractionLeaseRequest,
  ): Promise<InteractionLease> {
    this.leaseRequests += 1;
    if (this.status === 'terminated') {
      throw new Error('session terminated');
    }
    const lease = new FakeLease(`lease-${this.id}`, this.id);
    this.leases.push(lease);
    return lease;
  }

  /** Simulates self-termination without going through the router. */
  terminate(): void {
    this.status = 'terminated';
  }
}

function leaseRequest(): InteractionLeaseRequest {
  return {
    mode: 'realtime',
    externalSessionId: 'discord:call-1',
    namespace: 'discord',
    signal: new AbortController().signal,
    model: {
      modelId: 'gpt-realtime',
      contextSize: 32000,
      inputCapabilities: { audio: { mediaTypes: ['audio/pcm'] } },
    },
  };
}

function setupLeaseHarness(options: { startGate?: Promise<void> } = {}) {
  const logging = {
    child: () => ({
      debug: () => undefined,
      error: () => undefined,
      info: () => undefined,
      warn: () => undefined,
    }),
  } as unknown as RootLogger;
  const mcp = {
    onPushNotification: () => () => undefined,
  } as unknown as Mcp;
  const sessions: FakeSession[] = [];
  const hooks: SessionHooks[] = [];
  const router = createRouter({
    logging,
    mcp,
    introspection: createIntrospectionMock(),
    createChatSession: (sessionHooks, _scope, _router, sessionId) => {
      hooks.push(sessionHooks);
      const session = new FakeSession(
        `${sessionId}-${sessions.length}`,
        sessions.length === 0 ? undefined : options.startGate,
      );
      sessions.push(session);
      return session;
    },
  });

  return { router, sessions, hooks };
}

const envelope = {
  eventId: 'event-1',
  sourceId: 'telegram:77',
  type: 'chat.message.received',
  createdAt: '2026-07-20T10:30:00.000Z',
};

describe('Router Push Notification adaptation', () => {
  it('creates the standard session with the stable default id', async () => {
    const harness = setup();
    await harness.router.start();
    expect(harness.createdSessionId).toBe('default');
  });

  it('passes through content blocks without validation', async () => {
    const harness = setup();
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
        eventId: 'telegram:event-1',
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
  });

  it('awaits session delivery before publication settles', async () => {
    const harness = setup();
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
  });

  it('maps resource_link blocks to resource_link content', async () => {
    const harness = setup();
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
  });

  it('maps embedded resource blocks with text contents', async () => {
    const harness = setup();
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
  });

  it('maps embedded resource blocks with blob contents', async () => {
    const harness = setup();
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
  });

  it('silently omits unknown content block types', async () => {
    const harness = setup();
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
  });

  it('preserves the MCP event ID when re-dispatching to a replacement session', async () => {
    const harness = setupLeaseHarness();
    await harness.router.start();

    harness.sessions[0]?.terminate();
    await harness.router.sendInput({
      eventId: 'telegram:event-9',
      sourceEnv: 'telegram',
      urgency: SessionInboxUrgency.Default,
      context: { sourceEnv: 'telegram', metadata: {}, content: [] },
    });

    expect(harness.sessions).toHaveLength(2);
    expect(harness.sessions[1]?.sent[0]?.eventId).toBe('telegram:event-9');
  });

  it('supports close followed by start without leaking scopes', async () => {
    const harness = setup();

    await harness.router.start();
    await harness.router.close();
    await harness.router.start();

    await harness.router.close();
  });
});

describe('Router interaction leases', () => {
  it('delegates acquisition to the active primary session', async () => {
    const harness = setupLeaseHarness();
    await harness.router.start();

    const lease = await harness.router.acquireInteractionLease(leaseRequest());

    expect(harness.sessions).toHaveLength(1);
    expect(harness.sessions[0]?.leaseRequests).toBe(1);
    expect(lease.sessionId).toBe(harness.sessions[0]?.id);
  });

  it('rejects acquisition before start and after close', async () => {
    const harness = setupLeaseHarness();

    await expect(
      harness.router.acquireInteractionLease(leaseRequest()),
    ).rejects.toBeInstanceOf(RouterUnavailableError);

    await harness.router.start();
    await harness.router.close();

    await expect(
      harness.router.acquireInteractionLease(leaseRequest()),
    ).rejects.toBeInstanceOf(RouterUnavailableError);
  });

  it('never acquires from a terminated session', async () => {
    const harness = setupLeaseHarness();
    await harness.router.start();
    harness.sessions[0]?.terminate();

    const lease = await harness.router.acquireInteractionLease(leaseRequest());

    expect(harness.sessions).toHaveLength(2);
    expect(harness.sessions[0]?.leaseRequests).toBe(0);
    expect(lease.sessionId).toBe(harness.sessions[1]?.id);
  });

  it('serializes acquisition against session replacement', async () => {
    let releaseStart: () => void = () => undefined;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const harness = setupLeaseHarness({ startGate });
    await harness.router.start();
    const first = harness.sessions[0];
    if (!first) throw new Error('missing session');

    // Self-termination begins while the replacement session is still starting.
    first.status = 'terminated';
    const terminated = harness.hooks[0]?.onTerminated?.({
      sessionId: first.id,
      reason: 'fatal',
      pendingEvents: [],
    });

    // Acquisition queued behind the in-flight replacement must observe the
    // replacement, not the terminated session and not a third session.
    const acquisition = harness.router.acquireInteractionLease(leaseRequest());
    releaseStart();
    await terminated;
    const lease = await acquisition;

    expect(harness.sessions).toHaveLength(2);
    expect(lease.sessionId).toBe(harness.sessions[1]?.id);
  });

  it('closes a replacement whose startup races router shutdown', async () => {
    let releaseStart: () => void = () => undefined;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const harness = setupLeaseHarness({ startGate });
    await harness.router.start();
    const first = harness.sessions[0];
    if (!first) throw new Error('missing session');
    first.status = 'terminated';

    const terminated = harness.hooks[0]?.onTerminated?.({
      sessionId: first.id,
      reason: 'fatal',
      pendingEvents: [],
    });
    await vi.waitFor(() => expect(harness.sessions).toHaveLength(2));
    const closing = harness.router.close();
    releaseStart();
    await Promise.all([terminated, closing]);

    expect(harness.sessions[1]?.closeCount).toBe(1);
    await expect(
      harness.router.acquireInteractionLease(leaseRequest()),
    ).rejects.toBeInstanceOf(RouterUnavailableError);
  });

  it('revokes the granted lease when the primary session closes', async () => {
    const harness = setupLeaseHarness();
    await harness.router.start();
    const lease = await harness.router.acquireInteractionLease(leaseRequest());

    await harness.router.close();

    await expect(lease.closed).resolves.toEqual({
      type: 'revoked',
      reason: 'primary-session-closed',
    });
  });
});
