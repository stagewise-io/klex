import { describe, expect, it, vi } from 'vitest';

import type { RootLogger } from '@stagewise/logger';

import type { IntrospectionScope } from '@/introspection';
import type { RouterApi } from '@/router';
import { SessionInboxUrgency } from '@/session/inbox';
import type {
  ChatSessionHandle,
  SessionHooks,
  SessionTerminationInfo,
} from '@/session/types';

import { createGodMessages } from './god-messages';

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

function createLoggingMock(): RootLogger {
  return {
    child: () => ({
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    }),
  } as unknown as RootLogger;
}

interface StubSession {
  sessionId: string;
  startCalls: number;
  closeCalls: number;
  sentMessages: { message: unknown; urgency: SessionInboxUrgency }[];
  status: 'active' | 'terminated';
  hooks: SessionHooks;
}

function createStubSessionFactory(startGate?: Promise<void>) {
  const sessions: StubSession[] = [];
  let sessionCounter = 0;

  const factory = (hooks: SessionHooks): ChatSessionHandle => {
    const stub: StubSession = {
      sessionId: `session-${++sessionCounter}`,
      startCalls: 0,
      closeCalls: 0,
      sentMessages: [],
      status: 'active',
      hooks,
    };

    const handle: ChatSessionHandle = {
      sessionId: stub.sessionId,
      status: stub.status,
      inbox: {
        send: vi.fn(),
        sendMessage: (message: never, urgency: SessionInboxUrgency) => {
          stub.sentMessages.push({ message, urgency });
        },
        close: vi.fn(),
      },
      start: async () => {
        stub.startCalls++;
        await startGate;
      },
      close: async () => {
        stub.closeCalls++;
        stub.status = 'terminated';
      },
      restorePendingEvents: vi.fn(),
    } as unknown as ChatSessionHandle;

    sessions.push(stub);
    return handle;
  };

  return { factory, sessions };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function getSession(sessions: StubSession[], index: number): StubSession {
  const session = sessions[index];
  if (!session) throw new Error(`Missing stub session at index ${index}`);
  return session;
}

function setup(startGate?: Promise<void>) {
  const { factory, sessions } = createStubSessionFactory(startGate);
  const logging = createLoggingMock();
  const router = {} as unknown as RouterApi;

  const godMessages = createGodMessages({
    logging,
    createChatSession: factory as never,
    introspection: createIntrospectionMock(),
    router,
  });

  return { godMessages, sessions, factory };
}

describe('GodMessagesModule — start()', () => {
  it('creates exactly one session on start', async () => {
    const { godMessages, sessions } = setup();

    await godMessages.start();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.startCalls).toBe(1);
  });

  it('is idempotent — second start does not create another session', async () => {
    const { godMessages, sessions } = setup();

    await godMessages.start();
    await godMessages.start();

    expect(sessions).toHaveLength(1);
  });
});

describe('GodMessagesModule — sendGodMessage()', () => {
  it('sends a message with data-god-message part and Default urgency', async () => {
    const { godMessages, sessions } = setup();
    await godMessages.start();

    const result = await godMessages.sendGodMessage([
      { type: 'text', text: 'Do this' },
    ]);

    expect(result.sessionId).toBe(sessions[0]?.sessionId);
    expect(sessions[0]?.sentMessages).toHaveLength(1);
    expect(sessions[0]?.sentMessages[0]?.urgency).toBe(
      SessionInboxUrgency.Default,
    );

    const msg = sessions[0]?.sentMessages[0]?.message as {
      role: string;
      parts: { type: string; data: { content: unknown[] } }[];
    };
    expect(msg.role).toBe('user');
    expect(msg.parts).toHaveLength(1);
    expect(msg.parts[0]?.type).toBe('data-god-message');
    expect(msg.parts[0]?.data.content).toEqual([
      { type: 'text', text: 'Do this' },
    ]);
  });

  it('returns the same sessionId for subsequent messages', async () => {
    const { godMessages, sessions } = setup();
    await godMessages.start();

    const r1 = await godMessages.sendGodMessage([
      { type: 'text', text: 'first' },
    ]);
    const r2 = await godMessages.sendGodMessage([
      { type: 'text', text: 'second' },
    ]);

    expect(r1.sessionId).toBe(r2.sessionId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sentMessages).toHaveLength(2);
  });

  it('deduplicates sends while the initial session is starting', async () => {
    const gate = deferred();
    const { godMessages, sessions } = setup(gate.promise);
    const start = godMessages.start();
    await vi.waitFor(() => expect(sessions).toHaveLength(1));

    const first = godMessages.sendGodMessage([{ type: 'text', text: 'first' }]);
    const second = godMessages.sendGodMessage([
      { type: 'text', text: 'second' },
    ]);
    gate.resolve();

    await Promise.all([start, first, second]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sentMessages).toHaveLength(2);
  });

  it('rejects messages before start', async () => {
    const { godMessages, sessions } = setup();

    await expect(
      godMessages.sendGodMessage([{ type: 'text', text: 'early' }]),
    ).rejects.toThrow('not running');
    expect(sessions).toHaveLength(0);
  });
});

describe('GodMessagesModule — close()', () => {
  it('closes the session on close', async () => {
    const { godMessages, sessions } = setup();
    await godMessages.start();

    await godMessages.close();

    expect(sessions[0]?.closeCalls).toBe(1);
  });

  it('is idempotent — second close does not close again', async () => {
    const { godMessages, sessions } = setup();
    await godMessages.start();

    await godMessages.close();
    await godMessages.close();

    expect(sessions[0]?.closeCalls).toBe(1);
  });

  it('is a no-op if start() was never called', async () => {
    const { godMessages, sessions } = setup();

    await godMessages.close();

    expect(sessions).toHaveLength(0);
  });

  it('awaits and closes a session still being created', async () => {
    const gate = deferred();
    const { godMessages, sessions } = setup(gate.promise);
    const start = godMessages.start();
    await vi.waitFor(() => expect(sessions).toHaveLength(1));

    const close = godMessages.close();
    gate.resolve();
    await Promise.all([start, close]);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.closeCalls).toBe(1);
  });

  it('supports close followed by start without leaking its scope', async () => {
    const { godMessages, sessions } = setup();

    await godMessages.start();
    await godMessages.close();
    await godMessages.start();

    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.closeCalls).toBe(1);
    expect(sessions[1]?.startCalls).toBe(1);
  });
});

describe('GodMessagesModule — onTerminated', () => {
  it('creates a replacement session when the god session self-terminates', async () => {
    const { godMessages, sessions } = setup();
    await godMessages.start();

    expect(sessions).toHaveLength(1);
    const originalSession = getSession(sessions, 0);

    // Simulate self-termination
    const info: SessionTerminationInfo = {
      sessionId: originalSession.sessionId,
      reason: 'fatal error',
      pendingEvents: [],
    };
    await originalSession.hooks.onTerminated?.(info);

    expect(sessions).toHaveLength(2);
    expect(sessions[1]?.startCalls).toBe(1);
  });

  it('does not replace a session terminated after shutdown', async () => {
    const { godMessages, sessions } = setup();
    await godMessages.start();
    const originalSession = getSession(sessions, 0);

    await godMessages.close();
    await originalSession.hooks.onTerminated?.({
      sessionId: originalSession.sessionId,
      reason: 'fatal error',
      pendingEvents: [],
    });

    expect(sessions).toHaveLength(1);
  });

  it('sendGodMessage uses the replacement session after termination', async () => {
    const { godMessages, sessions } = setup();
    await godMessages.start();

    const originalSessionId = getSession(sessions, 0).sessionId;

    // Simulate self-termination
    const info: SessionTerminationInfo = {
      sessionId: originalSessionId,
      reason: 'fatal error',
      pendingEvents: [],
    };
    await getSession(sessions, 0).hooks.onTerminated?.(info);

    const result = await godMessages.sendGodMessage([
      { type: 'text', text: 'after termination' },
    ]);

    expect(result.sessionId).not.toBe(originalSessionId);
    expect(result.sessionId).toBe(sessions[1]?.sessionId);
    expect(sessions[1]?.sentMessages).toHaveLength(1);
  });
});
