import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RootLogger } from '@stagewise/logger';

import { AdmissionGate } from '@/admission';
import type { Config } from '@/config';
import type { IntrospectionScope } from '@/introspection';
import { SessionInboxUrgency } from '@/session/inbox';

import { createChatSession } from './chat-session';
import type {
  ExtensionDeps,
  ExtensionFactory,
} from './extensions/extension-api';
import type { SessionInboxBuffer } from './inbox';
import type { ExtendedUIMessage } from './message-types';
import type { Turn, TurnResult } from './turn';

const { createTurn } = vi.hoisted(() => ({ createTurn: vi.fn() }));

vi.mock('./turn', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./turn')>()),
  createTurn,
}));

const logger = {
  debug: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
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
  afterEach(() => {
    vi.useRealTimers();
    createTurn.mockReset();
  });

  it('includes input resumed at a paused continuation boundary in the next turn', async () => {
    vi.useFakeTimers();
    const admission = new AdmissionGate({ graceMs: 1_000, maxDescendants: 0 });
    const session = createChatSession({
      admission,
      logging: { child: () => logger } as unknown as RootLogger,
      config: {
        get: () => ({ modelSelection: { chat: ['test:model'] } }),
      } as unknown as Config,
      modelResolver: { resolveModelInfo: () => undefined } as never,
      dataDirectory: '/tmp/klex-chat-session-checkpoint-test',
      mcp: null,
      extensionFactories: [],
      introspectionScope: createScope(),
      sessionContext: { kind: 'default', name: 'main', sessionId: 'default' },
      basePrompt: 'You are Klex.',
    });
    await session.start();
    const running = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const resumed: ExtendedUIMessage = {
      id: 'resumed',
      role: 'user',
      parts: [{ type: 'text', text: 'read this before generating' }],
    };
    createTurn
      .mockImplementationOnce(() => ({
        ...fakeTurn(() => undefined),
        run: async () => {
          running.resolve();
          await finish.promise;
          return success;
        },
      }))
      .mockImplementationOnce(
        (options: {
          messages: ExtendedUIMessage[];
          inbox: SessionInboxBuffer;
        }) =>
          fakeTurn(() => {
            expect(options.messages).toContainEqual(resumed);
            options.inbox.drain(options.messages, logger);
          }),
      );
    session.inbox.sendMessage(
      { id: 'first', role: 'user', parts: [{ type: 'text', text: 'first' }] },
      SessionInboxUrgency.Default,
    );
    await running.promise;
    session.inbox.sendMessage(
      {
        id: 'queued',
        role: 'user',
        parts: [{ type: 'text', text: 'continue' }],
      },
      SessionInboxUrgency.Deferrable,
    );
    const acceptedDelivery = admission.admitRoot();
    const preparing = admission.prepare();
    finish.resolve();
    await vi.waitFor(() => expect(admission.status().deferredWork).toBe(1), {
      interval: 10,
    });
    expect(
      acceptedDelivery.run(() =>
        session.inbox.sendMessage(resumed, SessionInboxUrgency.Default),
      ),
    ).toMatchObject({ status: 'deferred' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await preparing).outcome).toBe('aborted');
    acceptedDelivery.release();
    await expect(session.waitForIdle(1_000)).resolves.toBe(true);
    expect(createTurn).toHaveBeenCalledTimes(2);
    expect(admission.status().activeWork).toBe(0);
    await session.close();
    admission.close();
  });
  it('holds accepted input through a turn and resumes deferred input on the same session after timeout', async () => {
    createTurn.mockReset();
    const admission = new AdmissionGate({ graceMs: 20 });
    const session = createChatSession({
      admission,
      logging: { child: () => logger } as unknown as RootLogger,
      config: {
        get: () => ({ modelSelection: { chat: ['test:model'] } }),
      } as unknown as Config,
      modelResolver: { resolveModelInfo: () => undefined } as never,
      dataDirectory: '/tmp/klex-chat-session-admission-test',
      mcp: null,
      extensionFactories: [],
      introspectionScope: createScope(),
      sessionContext: { kind: 'default', name: 'main', sessionId: 'default' },
      basePrompt: 'You are Klex.',
    });
    await session.start();
    const running = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    createTurn
      .mockImplementationOnce(() => ({
        ...fakeTurn(() => undefined),
        run: async () => {
          running.resolve();
          await finish.promise;
          return success;
        },
      }))
      .mockImplementationOnce(() => fakeTurn(() => undefined));
    const first: ExtendedUIMessage = {
      id: 'admitted',
      role: 'user',
      parts: [{ type: 'text', text: 'first' }],
    };
    const next: ExtendedUIMessage = {
      id: 'deferred',
      role: 'user',
      parts: [{ type: 'text', text: 'second' }],
    };
    session.inbox.sendMessage(first, SessionInboxUrgency.Default);
    await running.promise;
    const preparing = admission.prepare();
    expect(() =>
      session.inbox.sendMessage(next, SessionInboxUrgency.Default),
    ).toThrow('Runtime is preparing maintenance');
    expect(session.getMessages()).not.toContainEqual(next);
    expect((await preparing).outcome).toBe('aborted');
    expect(session.status).toBe('active');
    expect(session.getMessages()).toContainEqual(first);
    finish.resolve();
    await expect(session.waitForIdle(1_000)).resolves.toBe(true);
    await vi.waitFor(() => expect(admission.status().activeWork).toBe(0));
    expect(session.getMessages()).not.toContainEqual(next);
    const prepared = await admission.prepare();
    expect(prepared.outcome).toBe('quiescent');
    if (prepared.outcome === 'quiescent')
      admission.abort('cancelled', prepared.lease);
    await session.close();
    admission.close();
    createTurn.mockReset();
  });
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
