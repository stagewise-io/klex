import { describe, expect, it, vi } from 'vitest';

import type { RootLogger } from '@stagewise/logger';

import type { IntrospectionScope } from '@/introspection';
import type { RouterApi } from '@/router';
import type { ExtendedUIMessage } from '@/session/chat/message-types';
import { SessionInboxClosedError, SessionInboxUrgency } from '@/session/inbox';
import type {
  ChatSessionHandle,
  SessionHooks,
  SessionInfo,
  SessionRuntimeState,
  SessionTerminationInfo,
} from '@/session/types';

import { createGodMessages } from './god-messages';

function createIntrospectionMock(): IntrospectionScope {
  const make = (): IntrospectionScope => ({
    path: [],
    introspect: () => undefined,
    child: () => make(),
    removeChild: () => undefined,
  });
  return make();
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
  runtimeState: SessionRuntimeState;
  messages: ExtendedUIMessage[];
  hooks: SessionHooks;
  inboxClosed: boolean;
}

function createStubSessionFactory() {
  const sessions: StubSession[] = [];
  let sessionCounter = 0;

  const factory = (hooks: SessionHooks): ChatSessionHandle => {
    const stub: StubSession = {
      sessionId: `session-${++sessionCounter}`,
      startCalls: 0,
      closeCalls: 0,
      sentMessages: [],
      status: 'active',
      runtimeState: 'idle',
      messages: [],
      hooks,
      inboxClosed: false,
    };

    const handle: ChatSessionHandle = {
      sessionId: stub.sessionId,
      status: stub.status,
      inbox: {
        send: vi.fn(),
        sendMessage: (message: never, urgency: SessionInboxUrgency) => {
          if (stub.inboxClosed) throw new SessionInboxClosedError();
          stub.sentMessages.push({ message, urgency });
        },
        close: () => {
          stub.inboxClosed = true;
        },
      },
      start: async () => {
        stub.startCalls++;
      },
      close: async () => {
        stub.closeCalls++;
        stub.inboxClosed = true;
        stub.status = 'terminated';
        stub.runtimeState = 'terminated';
      },
      restorePendingEvents: vi.fn(),
      getMessages: () => [...stub.messages],
      getSessionInfo: (): SessionInfo => ({
        id: stub.sessionId,
        status: stub.status,
        runtimeState: stub.runtimeState,
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
        messageCount: stub.messages.length,
        createdAt: new Date().toISOString(),
      }),
    } as unknown as ChatSessionHandle;

    sessions.push(stub);
    // Store the handle on the stub so tests can access it
    (stub as unknown as { handle: ChatSessionHandle }).handle = handle;
    return handle;
  };

  return { factory, sessions };
}

function getSession(sessions: StubSession[], index: number): StubSession {
  const session = sessions[index];
  if (!session) throw new Error(`Missing stub session at index ${index}`);
  return session;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function sessionHandle(stub: StubSession): ChatSessionHandle {
  return (stub as unknown as { handle: ChatSessionHandle }).handle;
}

function setup() {
  const { factory, sessions } = createStubSessionFactory();
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

  it('rejects delivery when shutdown wins the session-acquisition race', async () => {
    const { godMessages, sessions } = setup();
    await godMessages.start();

    const sending = godMessages.sendGodMessage([
      { type: 'text', text: 'too late' },
    ]);
    await godMessages.close();

    await expect(sending).rejects.toMatchObject({ code: 'not-running' });
    expect(sessions[0]?.sentMessages).toHaveLength(0);
  });

  it('retries delivery when self-termination has closed the inbox', async () => {
    const { godMessages, sessions } = setup();
    await godMessages.start();
    sessionHandle(getSession(sessions, 0)).inbox.close();

    const result = await godMessages.sendGodMessage([
      { type: 'text', text: 'survive termination' },
    ]);

    expect(result.sessionId).toBe(sessions[1]?.sessionId);
    expect(sessions[1]?.sentMessages).toHaveLength(1);
  });

  it('rejects messages before the module is started', async () => {
    const { godMessages, sessions } = setup();

    await expect(
      godMessages.sendGodMessage([{ type: 'text', text: 'too early' }]),
    ).rejects.toMatchObject({ code: 'not-running' });
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

  it('ignores termination callbacks after shutdown', async () => {
    const { godMessages, sessions } = setup();
    await godMessages.start();
    const originalSession = getSession(sessions, 0);
    await godMessages.close();

    await originalSession.hooks.onTerminated?.({
      sessionId: originalSession.sessionId,
      reason: 'closed',
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

describe('GodMessagesModule — getSessionInfo()', () => {
  it('returns null when no session exists', () => {
    const { godMessages } = setup();
    expect(godMessages.getSessionInfo()).toBeNull();
  });

  it('returns session info when session exists', async () => {
    const { godMessages, sessions } = setup();
    await godMessages.start();

    const info = godMessages.getSessionInfo();
    expect(info).not.toBeNull();
    expect(info?.id).toBe(sessions[0]?.sessionId);
    expect(info?.runtimeState).toBe('idle');
  });
});

describe('GodMessagesModule — getMessages()', () => {
  it('returns empty array when no session exists', () => {
    const { godMessages } = setup();
    expect(godMessages.getMessages()).toEqual([]);
  });

  it('returns messages from the session', async () => {
    const { godMessages, sessions } = setup();
    await godMessages.start();

    const msg: ExtendedUIMessage = {
      id: 'msg-1',
      role: 'user',
      parts: [{ type: 'text', text: 'hello' }],
    } as unknown as ExtendedUIMessage;
    getSession(sessions, 0).messages.push(msg);

    const result = godMessages.getMessages();
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('msg-1');
  });
});

describe('GodMessagesModule — resetSession()', () => {
  it('throws when module is not started', async () => {
    const { godMessages } = setup();
    await expect(godMessages.resetSession()).rejects.toMatchObject({
      code: 'not-running',
    });
  });

  it('throws when session is busy (working)', async () => {
    const { godMessages, sessions } = setup();
    await godMessages.start();

    getSession(sessions, 0).runtimeState = 'working';

    await expect(godMessages.resetSession()).rejects.toMatchObject({
      code: 'session-busy',
    });
    expect(sessions).toHaveLength(1);
  });

  it('throws when session is busy (retrying)', async () => {
    const { godMessages, sessions } = setup();
    await godMessages.start();

    getSession(sessions, 0).runtimeState = 'retrying';

    await expect(godMessages.resetSession()).rejects.toMatchObject({
      code: 'session-busy',
    });
  });

  it('succeeds when idle, creates a new session, returns new sessionId', async () => {
    const { godMessages, sessions } = setup();
    await godMessages.start();

    const originalId = getSession(sessions, 0).sessionId;
    const result = await godMessages.resetSession();

    expect(result.sessionId).not.toBe(originalId);
    expect(sessions).toHaveLength(2);
    expect(sessions[1]?.startCalls).toBe(1);
  });

  it('succeeds when terminated (error state)', async () => {
    const { godMessages, sessions } = setup();
    await godMessages.start();

    getSession(sessions, 0).runtimeState = 'terminated';

    const result = await godMessages.resetSession();
    expect(sessions).toHaveLength(2);
    expect(result.sessionId).toBe(sessions[1]?.sessionId);
  });

  it('old session is closed on reset', async () => {
    const { godMessages, sessions } = setup();
    await godMessages.start();

    await godMessages.resetSession();

    expect(sessions[0]?.closeCalls).toBe(1);
  });

  it('rejects overlapping resets', async () => {
    const { godMessages, sessions } = setup();
    await godMessages.start();
    const closeGate = deferred();
    sessionHandle(getSession(sessions, 0)).close = async () =>
      closeGate.promise;

    const resetPromise = godMessages.resetSession();
    await expect(godMessages.resetSession()).rejects.toMatchObject({
      code: 'reset-in-progress',
    });

    closeGate.resolve();
    await resetPromise;
  });

  it('rejects messages while resetting', async () => {
    const { godMessages, sessions } = setup();
    await godMessages.start();
    const closeGate = deferred();
    sessionHandle(getSession(sessions, 0)).close = async () =>
      closeGate.promise;

    const resetPromise = godMessages.resetSession();
    await expect(
      godMessages.sendGodMessage([{ type: 'text', text: 'during reset' }]),
    ).rejects.toMatchObject({ code: 'reset-in-progress' });

    closeGate.resolve();
    await resetPromise;
  });

  it('does not create a fresh session if shutdown interrupts reset', async () => {
    const { godMessages, sessions } = setup();
    await godMessages.start();
    const closeGate = deferred();
    sessionHandle(getSession(sessions, 0)).close = async () =>
      closeGate.promise;

    const resetPromise = godMessages.resetSession();
    await godMessages.close();
    closeGate.resolve();

    await expect(resetPromise).rejects.toMatchObject({ code: 'not-running' });
    expect(sessions).toHaveLength(1);
  });

  it('ignores delayed termination callbacks from a replaced session', async () => {
    const { godMessages, sessions } = setup();
    await godMessages.start();
    const originalSession = getSession(sessions, 0);
    await godMessages.resetSession();

    await originalSession.hooks.onTerminated?.({
      sessionId: originalSession.sessionId,
      reason: 'closed during reset',
      pendingEvents: [],
    });

    expect(sessions).toHaveLength(2);
    expect(godMessages.getSessionInfo()?.id).toBe(sessions[1]?.sessionId);
  });

  it('ignores termination callbacks from the old session during reset', async () => {
    const { godMessages, sessions } = setup();
    await godMessages.start();
    const originalSession = getSession(sessions, 0);
    const closeGate = deferred();
    sessionHandle(originalSession).close = async () => closeGate.promise;

    const resetPromise = godMessages.resetSession();
    await originalSession.hooks.onTerminated?.({
      sessionId: originalSession.sessionId,
      reason: 'fatal error',
      pendingEvents: [],
    });
    closeGate.resolve();
    await resetPromise;

    expect(sessions).toHaveLength(2);
  });
});
