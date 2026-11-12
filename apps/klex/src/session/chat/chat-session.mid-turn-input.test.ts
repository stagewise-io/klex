import { describe, expect, it, vi } from 'vitest';

import type { RootLogger } from '@stagewise/logger';

import type { Config } from '@/config';
import type { IntrospectionScope } from '@/introspection';
import { SessionInboxUrgency } from '@/session/inbox';

import { createChatSession } from './chat-session';
import type {
  ExtensionDeps,
  ExtensionFactory,
} from './extensions/extension-api';
import { wrapMemoryResult } from './extensions/memory/retrieval/memory-result';
import type { ExtendedUIMessage } from './message-types';
import type { createTurn as createTurnType, Turn, TurnResult } from './turn';

const { createTurn } = vi.hoisted(() => ({ createTurn: vi.fn() }));

vi.mock('./turn', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./turn')>()),
  createTurn,
}));

const logger = {
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  trace: vi.fn(),
  warn: vi.fn(),
};

function createScope(path: string[] = []): IntrospectionScope {
  return {
    path,
    introspect: vi.fn(),
    child: vi.fn((id: string) => createScope([...path, id])),
    removeChild: vi.fn(),
  };
}

const success: TurnResult = {
  fatalError: false,
  fatalErrorReason: null,
  completeFailure: false,
  requestRejected: false,
  stopReason: 'completed',
  stepCount: 1,
  usage: null,
};

function fakeTurn(run: () => void): Turn {
  return {
    run: vi.fn(async () => {
      run();
      return success;
    }),
    abortGeneration: vi.fn(),
    abortTools: vi.fn(),
  } as unknown as Turn;
}

describe('ChatSession mid-turn input', () => {
  it('runs a check turn for input sent during a turn instead of going idle', async () => {
    let deps: ExtensionDeps | undefined;
    const extension: ExtensionFactory = {
      identifier: 'test/mid-turn',
      create: (extensionDeps) => {
        deps = extensionDeps;
        return {};
      },
    };
    const session = createChatSession({
      logging: { child: () => logger } as unknown as RootLogger,
      config: {
        get: () => ({ modelSelection: { chat: ['test:model'] } }),
      } as unknown as Config,
      modelResolver: { resolveModelInfo: () => undefined } as never,
      dataDirectory: '/tmp/klex-chat-session-mid-turn-test',
      mcp: null,
      extensionFactories: [extension],
      introspectionScope: createScope(),
      sessionContext: { kind: 'default', name: 'main', sessionId: 'default' },
      basePrompt: 'You are Klex.',
    });
    await session.start();

    // Mirrors a todo reminder firing while the agent is mid-step.
    const reminder = {
      id: 'reminder-1',
      role: 'user',
      parts: [{ type: 'text', text: 'reminder' }],
    } as ExtendedUIMessage;
    createTurn
      .mockImplementationOnce(() =>
        fakeTurn(() =>
          deps?.inbox.sendMessage(reminder, SessionInboxUrgency.Default),
        ),
      )
      .mockImplementationOnce(() => fakeTurn(() => undefined));

    session.inbox.send({
      sourceEnv: 'test',
      urgency: SessionInboxUrgency.Default,
      context: {
        sourceEnv: 'test',
        metadata: {},
        content: [{ type: 'text', text: 'start' }],
      },
    });

    await expect(session.waitForIdle(1_000)).resolves.toBe(true);
    expect(createTurn).toHaveBeenCalledTimes(2);
    expect(createTurn.mock.calls[1]?.[0]).toMatchObject({ forceCheck: true });
    expect(session.getMessages()).toContainEqual(reminder);

    await session.close();
  });
});

describe('ChatSession turn trigger', () => {
  function createSession() {
    let deps: ExtensionDeps | undefined;
    const extension: ExtensionFactory = {
      identifier: 'test/memory',
      create: (extensionDeps) => {
        deps = extensionDeps;
        return {};
      },
    };
    const session = createChatSession({
      logging: { child: () => logger } as unknown as RootLogger,
      config: {
        get: () => ({ modelSelection: { chat: ['test:model'] } }),
      } as unknown as Config,
      modelResolver: { resolveModelInfo: () => undefined } as never,
      dataDirectory: '/tmp/klex-chat-session-turn-trigger-test',
      mcp: null,
      extensionFactories: [extension],
      introspectionScope: createScope(),
      sessionContext: { kind: 'default', name: 'main', sessionId: 'default' },
      basePrompt: 'You are Klex.',
    });
    const sendMemory = () =>
      deps?.inbox.sendMessage(
        {
          id: 'memory-1',
          role: 'user',
          parts: [{ type: 'text', text: wrapMemoryResult('remembered') }],
        } as ExtendedUIMessage,
        SessionInboxUrgency.Deferrable,
      );
    // Drains deferred input like a real turn, recording the flag it sees.
    const seen: (boolean | undefined)[] = [];
    createTurn.mockImplementationOnce(
      (turnDeps: Parameters<typeof createTurnType>[0]) =>
        fakeTurn(() => {
          turnDeps.inbox.drain(turnDeps.messages, turnDeps.logger);
          seen.push(session.getSessionInfo().triggeredByMemoryOnly);
        }),
    );
    return { session, sendMemory, seen };
  }

  it('flags a busy period woken only by memory results', async () => {
    const { session, sendMemory, seen } = createSession();
    await session.start();

    sendMemory();

    await expect(session.waitForIdle(1_000)).resolves.toBe(true);
    expect(seen).toEqual([true]);
    expect(session.getSessionInfo().triggeredByMemoryOnly).toBe(false);
    await session.close();
  });

  const leaseRequest = () => ({
    mode: 'realtime' as const,
    externalSessionId: 'test-call',
    namespace: 'test',
    signal: new AbortController().signal,
    model: { modelId: 'test', contextSize: 32_000, inputCapabilities: {} },
  });

  it('does not flag a turn that follows a lease, even with buffered memory', async () => {
    const { session, sendMemory, seen } = createSession();
    await session.start();
    const lease = await session.acquireInteractionLease(leaseRequest());

    sendMemory();
    expect(session.getSessionInfo().runtimeState).toBe('leased');
    await lease.release();

    await expect(session.waitForIdle(1_000)).resolves.toBe(true);
    expect(seen).toEqual([false]);
    await session.close();
  });

  it('flags a memory-only wake after a lease that left no input', async () => {
    const { session, sendMemory, seen } = createSession();
    await session.start();
    const lease = await session.acquireInteractionLease(leaseRequest());
    await lease.release();

    sendMemory();

    await expect(session.waitForIdle(1_000)).resolves.toBe(true);
    expect(seen).toEqual([true]);
    await session.close();
  });

  it('does not flag a busy period that other input also woke', async () => {
    const { session, sendMemory, seen } = createSession();
    await session.start();

    sendMemory();
    session.inbox.send({
      sourceEnv: 'test',
      urgency: SessionInboxUrgency.Deferrable,
      context: {
        sourceEnv: 'test',
        metadata: {},
        content: [{ type: 'text', text: 'user message' }],
      },
    });

    await expect(session.waitForIdle(1_000)).resolves.toBe(true);
    expect(seen).toEqual([false]);
    await session.close();
  });
});
