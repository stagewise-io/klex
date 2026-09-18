import { describe, expect, it, vi } from 'vitest';

import type { RootLogger } from '@stagewise/logger';

import type { IntrospectionScope } from '@/introspection';
import type { Mcp } from '@/mcp';
import { SessionInboxUrgency } from '@/session/inbox';
import type {
  ChatSessionHandle,
  SessionFactory,
  SessionHooks,
  SessionInfo,
  SessionStatus,
} from '@/session/types';

import { createSessionHost } from './session-host';

const logging = {
  child: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  }),
} as unknown as RootLogger;

function createScope(path: string[] = []): IntrospectionScope {
  const children = new Map<string, IntrospectionScope>();
  return {
    path,
    introspect: vi.fn(),
    child: vi.fn((id: string) => {
      if (children.has(id)) throw new Error(`Duplicate child: ${id}`);
      const child = createScope([...path, id]);
      children.set(id, child);
      return child;
    }),
    removeChild: vi.fn((id: string) => {
      children.delete(id);
    }),
  };
}

interface FakeSession extends ChatSessionHandle {
  status: SessionStatus;
  hooks?: SessionHooks;
}

function createFakeSession(options: {
  hooks?: SessionHooks;
  start?: () => Promise<void>;
}): FakeSession {
  const session: FakeSession = {
    sessionId: 'default',
    status: 'active',
    hooks: options.hooks,
    inbox: {
      send: vi.fn(),
      sendMessage: vi.fn(),
      close: vi.fn(),
    },
    start: vi.fn(options.start ?? (async () => undefined)),
    close: vi.fn(async () => {
      session.status = 'terminated';
    }),
    restorePendingEvents: vi.fn(),
    getMessages: vi.fn(() => []),
    getSessionInfo: vi.fn(
      (): SessionInfo => ({
        id: 'default',
        status: session.status,
        runtimeState: session.status === 'active' ? 'idle' : 'terminated',
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
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    ),
    acquireInteractionLease: vi.fn(
      async () =>
        ({
          id: 'lease-1',
          sessionId: 'default',
        }) as never,
    ),
    createChildSession: vi.fn(),
    waitForIdle: vi.fn(async () => true),
  };
  return session;
}

function getSession(sessions: FakeSession[], index: number): FakeSession {
  const session = sessions[index];
  if (!session) throw new Error(`Missing fake session at index ${index}`);
  return session;
}

function createHost(sessionFactory: SessionFactory) {
  return createSessionHost({
    logging,
    mcp: {} as Mcp,
    introspection: createScope(),
    sessionFactory,
    basePrompt: 'test base prompt',
  });
}

describe('SessionHost', () => {
  it('starts only one default session when start is called repeatedly', async () => {
    const sessions: FakeSession[] = [];
    const host = createHost((params) => {
      const session = createFakeSession({ hooks: params.hooks });
      sessions.push(session);
      return session;
    });

    await Promise.all([host.start(), host.start()]);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.start).toHaveBeenCalledOnce();
    await host.close();
  });

  it('cleans up and rejects startup when the default session cannot start', async () => {
    const startupError = new Error('extension failed to start');
    const session = createFakeSession({
      start: async () => {
        throw startupError;
      },
    });
    const host = createHost(() => session);

    await expect(host.start()).rejects.toBe(startupError);
    expect(session.close).toHaveBeenCalledOnce();
  });

  it('rejects startup when the default session terminates while starting', async () => {
    const session = createFakeSession({});
    session.start = vi.fn(async () => {
      session.status = 'terminated';
    });
    const host = createHost(() => session);

    await expect(host.start()).rejects.toThrow(
      'Default session terminated during startup',
    );
    expect(session.close).toHaveBeenCalledOnce();
  });

  it('retains pending events when replacement startup fails and retries later', async () => {
    const pendingEvent = {
      eventId: 'pending-retry',
      sourceEnv: 'test',
      urgency: SessionInboxUrgency.Default,
      context: {
        sourceEnv: 'test',
        metadata: {},
        content: [{ type: 'text' as const, text: 'retry me' }],
      },
    };
    const sessions: FakeSession[] = [];
    let attempt = 0;
    const host = createHost((params) => {
      attempt++;
      const session = createFakeSession({
        hooks: params.hooks,
        ...(attempt === 2 && {
          start: async () => {
            throw new Error('replacement startup failed');
          },
        }),
      });
      sessions.push(session);
      return session;
    });
    await host.start();

    const terminated = getSession(sessions, 0);
    terminated.status = 'terminated';
    await terminated.hooks?.onTerminated?.({
      sessionId: 'default',
      reason: 'fatal test error',
      pendingEvents: [pendingEvent],
    });

    expect(sessions).toHaveLength(2);
    expect(sessions[1]?.close).toHaveBeenCalledOnce();

    await host.acquireInteractionLease({} as never);

    expect(sessions).toHaveLength(3);
    expect(sessions[2]?.restorePendingEvents).toHaveBeenCalledWith([
      pendingEvent,
    ]);
    await host.close();
  });

  it('replaces a terminated session and restores its pending events', async () => {
    const sessions: FakeSession[] = [];
    const host = createHost((params) => {
      const session = createFakeSession({ hooks: params.hooks });
      sessions.push(session);
      return session;
    });
    await host.start();

    const terminated = getSession(sessions, 0);
    terminated.status = 'terminated';
    const pendingEvent = {
      eventId: 'pending-1',
      sourceEnv: 'test',
      urgency: SessionInboxUrgency.Default,
      context: {
        sourceEnv: 'test',
        metadata: {},
        content: [{ type: 'text' as const, text: 'hello' }],
      },
    };

    await terminated.hooks?.onTerminated?.({
      sessionId: 'default',
      reason: 'fatal test error',
      pendingEvents: [pendingEvent],
    });

    expect(sessions).toHaveLength(2);
    const replacement = getSession(sessions, 1);
    expect(replacement.restorePendingEvents).toHaveBeenCalledWith([
      pendingEvent,
    ]);
    await host.close();
  });
});
