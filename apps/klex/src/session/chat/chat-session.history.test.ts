import { describe, expect, it, vi } from 'vitest';

import type { RootLogger } from '@stagewise/logger';

import type { Config } from '@/config';
import type { IntrospectionScope } from '@/introspection';
import type {
  ChatSessionHandle,
  SessionContext,
  SessionFactory,
} from '@/session/types';
import type {
  SessionHistory,
  SessionHistoryRecorder,
  SessionHistoryRecorderMetadata,
} from '@/session-history';

import { createChatSession } from './chat-session';
import type {
  ExtensionDeps,
  ExtensionFactory,
} from './extensions/extension-api';
import type { ExtendedUIMessage } from './message-types';

const logger = {
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  trace: vi.fn(),
  warn: vi.fn(),
};
const logging = { child: () => logger } as unknown as RootLogger;
const config = {
  get: () => ({ modelSelection: { chat: ['test:model'] } }),
} as unknown as Config;
const modelResolver = { resolveModelInfo: () => undefined } as never;

function createScope(path: string[] = []): IntrospectionScope {
  return {
    path,
    introspect: vi.fn(),
    child: vi.fn((id: string) => createScope([...path, id])),
    removeChild: vi.fn(),
  };
}

interface FakeRecorder {
  meta: SessionHistoryRecorderMetadata;
  recorder: SessionHistoryRecorder;
  snapshots: (readonly ExtendedUIMessage[])[];
}

function fakeSessionHistory(options: { endError?: Error } = {}): {
  history: SessionHistory;
  recorders: FakeRecorder[];
} {
  const recorders: FakeRecorder[] = [];
  const history = {
    openRecorder: vi.fn((meta: SessionHistoryRecorderMetadata) => {
      const entry: FakeRecorder = {
        meta,
        snapshots: [],
        recorder: {
          instanceId: meta.instanceId,
          scheduleSync: vi.fn((getMessages) => {
            entry.snapshots.push([...getMessages()]);
          }),
          end: vi.fn(async () => {
            if (options.endError) throw options.endError;
          }),
        },
      };
      recorders.push(entry);
      return entry.recorder;
    }),
  } as unknown as SessionHistory;
  return { history, recorders };
}

function captureExtension(): {
  factory: ExtensionFactory;
  deps: () => ExtensionDeps;
} {
  let captured: ExtensionDeps | undefined;
  return {
    factory: {
      identifier: 'test/capture',
      create: (deps) => {
        captured = deps;
        return {};
      },
    },
    deps: () => {
      if (!captured) throw new Error('Extension deps were not captured');
      return captured;
    },
  };
}

function createSession(options: {
  sessionHistory: SessionHistory;
  extensions?: ExtensionFactory[];
  sessionContext?: SessionContext;
  sessionFactory?: SessionFactory;
  introspectionScope?: IntrospectionScope;
}): ChatSessionHandle {
  return createChatSession({
    logging,
    config,
    modelResolver,
    dataDirectory: '/tmp/klex-chat-session-history-test',
    mcp: null,
    extensionFactories: options.extensions ?? [],
    introspectionScope: options.introspectionScope ?? createScope(),
    sessionContext: options.sessionContext ?? {
      kind: 'default',
      name: 'main',
      sessionId: 'default',
    },
    sessionFactory: options.sessionFactory,
    basePrompt: 'You are Klex.',
    sessionHistory: options.sessionHistory,
  });
}

function message(id: string): ExtendedUIMessage {
  return { id, role: 'user', parts: [] } as unknown as ExtendedUIMessage;
}

function internals(session: ChatSessionHandle): {
  instanceId: string;
  messages: ExtendedUIMessage[];
  terminate(reason: string): Promise<void>;
} {
  return session as unknown as {
    instanceId: string;
    messages: ExtendedUIMessage[];
    terminate(reason: string): Promise<void>;
  };
}

function requireRecorder(recorders: FakeRecorder[], index = 0): FakeRecorder {
  const entry = recorders[index];
  if (!entry) throw new Error(`Recorder ${index} was not opened`);
  return entry;
}

describe('ChatSession transcript persistence', () => {
  it('opens one recorder per instance with distinct instance ids', async () => {
    const { history, recorders } = fakeSessionHistory();
    const first = createSession({ sessionHistory: history });
    const replacement = createSession({ sessionHistory: history });

    const firstMeta = requireRecorder(recorders, 0).meta;
    const replacementMeta = requireRecorder(recorders, 1).meta;
    expect(firstMeta).toMatchObject({
      instanceId: internals(first).instanceId,
      sessionId: 'default',
      kind: 'default',
      name: 'main',
    });
    expect(firstMeta.parentInstanceId).toBeUndefined();
    expect(replacementMeta.sessionId).toBe('default');
    expect(replacementMeta.instanceId).not.toBe(firstMeta.instanceId);

    await first.close();
    await replacement.close();
  });

  it('schedules a sync after a successful insertMessageAfter', async () => {
    const { history, recorders } = fakeSessionHistory();
    const capture = captureExtension();
    const session = createSession({
      sessionHistory: history,
      extensions: [capture.factory],
    });
    internals(session).messages.push(message('a'));

    expect(capture.deps().insertMessageAfter('missing', message('x'))).toBe(
      false,
    );
    expect(requireRecorder(recorders).snapshots).toHaveLength(0);

    expect(capture.deps().insertMessageAfter('a', message('b'))).toBe(true);
    expect(
      requireRecorder(recorders)
        .snapshots.at(-1)
        ?.map((m) => m.id),
    ).toEqual(['a', 'b']);

    await session.close();
  });

  it('schedules a sync on each post-step flush', async () => {
    const { history, recorders } = fakeSessionHistory();
    const session = createSession({ sessionHistory: history });
    const flush = (session as unknown as { flushPendingImmediate: () => void })
      .flushPendingImmediate;

    flush();
    flush();

    expect(
      requireRecorder(recorders).recorder.scheduleSync,
    ).toHaveBeenCalledTimes(2);
    await session.close();
  });

  it('ends the transcript once on close before introspection removal', async () => {
    const { history, recorders } = fakeSessionHistory();
    const scope = createScope();
    const session = createSession({
      sessionHistory: history,
      introspectionScope: scope,
    });
    const { recorder } = requireRecorder(recorders);

    await session.close();
    await session.close();

    expect(recorder.end).toHaveBeenCalledOnce();
    expect(recorder.end).toHaveBeenCalledWith('closed');
    const endOrder = vi.mocked(recorder.end).mock.invocationCallOrder[0];
    const removeOrder = vi.mocked(scope.removeChild).mock
      .invocationCallOrder[0];
    expect(endOrder).toBeLessThan(removeOrder ?? 0);
  });

  it('records the fatal reason on self-termination', async () => {
    const { history, recorders } = fakeSessionHistory();
    const session = createSession({ sessionHistory: history });

    await internals(session).terminate('bad_request');

    expect(requireRecorder(recorders).recorder.end).toHaveBeenCalledWith(
      'terminated: bad_request',
    );
  });

  it('does not block cleanup when the transcript end fails', async () => {
    const { history } = fakeSessionHistory({
      endError: new Error('disk full'),
    });
    const scope = createScope();
    const session = createSession({
      sessionHistory: history,
      introspectionScope: scope,
    });

    await expect(session.close()).resolves.toBeUndefined();
    expect(scope.removeChild).toHaveBeenCalledWith('default');
  });

  it('passes the parent instance id to child sessions', async () => {
    const { history } = fakeSessionHistory();
    const capture = captureExtension();
    let childContext: SessionContext | undefined;
    const sessionFactory: SessionFactory = (params) => {
      childContext = params.sessionContext;
      throw new Error('stop after capture');
    };
    const parent = createSession({
      sessionHistory: history,
      extensions: [capture.factory],
      sessionFactory,
    });
    await parent.start();

    await expect(
      capture.deps().createChildSession({
        name: 'test-child',
        extensionIdentifier: 'test-extension',
        extensions: [],
        basePrompt: 'You are a child.',
      }),
    ).rejects.toThrow('stop after capture');
    expect(childContext?.parentInstanceId).toBe(internals(parent).instanceId);
    expect(childContext?.parentId).toBe('default');

    await parent.close();
  });
});
