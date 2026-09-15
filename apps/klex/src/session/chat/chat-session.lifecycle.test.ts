import { describe, expect, it, vi } from 'vitest';

import type { RootLogger } from '@stagewise/logger';

import type { Config } from '@/config';
import type { IntrospectionScope } from '@/introspection';
import type { Mcp } from '@/mcp';
import type {
  ChatSessionHandle,
  ChildSessionHandle,
  SessionFactory,
} from '@/session/types';

import { createChatSession } from './chat-session';
import type {
  ExtensionDeps,
  ExtensionFactory,
} from './extensions/extension-api';

vi.mock('./utils/system-prompt.md', () => ({ default: 'You are Klex.' }));

const logger = {
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  trace: vi.fn(),
  warn: vi.fn(),
};
const logging = {
  child: () => logger,
} as unknown as RootLogger;
const config = {
  get: () => ({ modelSelection: { chat: ['test:model'] } }),
} as unknown as Config;
const modelResolver = {
  resolveModelInfo: () => undefined,
} as never;

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

function createSession(
  options: {
    extensions?: ExtensionFactory[];
    mcp?: Mcp | null;
    sessionFactory?: SessionFactory;
  } = {},
): ChatSessionHandle {
  return createChatSession({
    logging,
    config,
    modelResolver,
    dataDirectory: '/tmp/klex-chat-session-lifecycle-test',
    mcp: options.mcp ?? null,
    extensionFactories: options.extensions ?? [],
    introspectionScope: createScope(),
    sessionContext: { kind: 'default', sessionId: 'default' },
    sessionFactory: options.sessionFactory,
  });
}

function createFakeChild(start: () => Promise<void>): ChildSessionHandle {
  const child: ChildSessionHandle = {
    sessionId: 'child-1',
    inbox: {
      send: vi.fn(),
      sendMessage: vi.fn(),
      close: vi.fn(),
    },
    start: vi.fn(start),
    close: vi.fn(async () => undefined),
    restorePendingEvents: vi.fn(),
    acquireInteractionLease: vi.fn(),
    getMessages: vi.fn(() => []),
    getSessionInfo: vi.fn(),
    createChildSession: vi.fn(),
    status: 'active',
  } as unknown as ChildSessionHandle;
  return child;
}

describe('ChatSession lifecycle', () => {
  it('starts extensions and subscribes to MCP only once', async () => {
    const onStart = vi.fn(async () => undefined);
    const unsubscribe = vi.fn();
    const onPushNotification = vi.fn(() => unsubscribe);
    const extension: ExtensionFactory = {
      identifier: 'test/lifecycle',
      create: () => ({ onStart }),
    };
    const session = createSession({
      extensions: [extension],
      mcp: { onPushNotification } as unknown as Mcp,
    });

    await Promise.all([session.start(), session.start()]);

    expect(onStart).toHaveBeenCalledOnce();
    expect(onPushNotification).toHaveBeenCalledOnce();

    await session.close();
    expect(unsubscribe).toHaveBeenCalledOnce();
    await expect(session.start()).rejects.toThrow(
      'Cannot start a terminated chat session',
    );
  });

  it('returns a child only after startup and preserves the requested extensions', async () => {
    let extensionDeps: ExtensionDeps | undefined;
    const parentExtension: ExtensionFactory = {
      identifier: 'test/parent',
      create: (deps) => {
        extensionDeps = deps;
        return {};
      },
    };
    const childExtension: ExtensionFactory = {
      identifier: 'test/parent',
      create: () => ({}),
    };
    const startup = Promise.withResolvers<void>();
    const child = createFakeChild(() => startup.promise);
    let childParams: Parameters<SessionFactory>[0] | undefined;
    const sessionFactory: SessionFactory = (params) => {
      childParams = params;
      return child as unknown as ChatSessionHandle;
    };
    const parent = createSession({
      extensions: [parentExtension],
      sessionFactory,
    });
    await parent.start();

    let resolved = false;
    const creation = extensionDeps!
      .createChildSession({ extensions: [childExtension] })
      .then((result) => {
        resolved = true;
        return result;
      });
    await Promise.resolve();

    expect(
      (child as unknown as ChatSessionHandle).start,
    ).toHaveBeenCalledOnce();
    expect(resolved).toBe(false);
    expect(childParams?.mcp).toBeNull();
    expect(childParams?.introspectionScope.path).toEqual([
      'default',
      'child-sessions',
    ]);
    expect(childParams?.extensionFactories).toEqual([childExtension]);

    startup.resolve();
    await expect(creation).resolves.toBe(child);
    await parent.close();
  });

  it('rolls back session-owned resources when extension construction fails', () => {
    const constructionError = new Error('extension construction failed');
    const introspectionScope = createScope();
    const extension: ExtensionFactory = {
      identifier: 'test/construction-failure',
      create: () => {
        throw constructionError;
      },
    };

    expect(() =>
      createChatSession({
        logging,
        config,
        modelResolver,
        dataDirectory: '/tmp/klex-chat-session-lifecycle-test',
        mcp: null,
        extensionFactories: [extension],
        introspectionScope,
        sessionContext: { kind: 'child', sessionId: 'failed-child' },
      }),
    ).toThrow(constructionError);
    expect(introspectionScope.removeChild).toHaveBeenCalledWith('failed-child');
  });

  it('cleans up and rejects when child startup fails', async () => {
    let extensionDeps: ExtensionDeps | undefined;
    const extension: ExtensionFactory = {
      identifier: 'test/parent',
      create: (deps) => {
        extensionDeps = deps;
        return {};
      },
    };
    const startupError = new Error('child startup failed');
    const child = createFakeChild(async () => {
      throw startupError;
    });
    const parent = createSession({
      extensions: [extension],
      sessionFactory: () => child as unknown as ChatSessionHandle,
    });
    await parent.start();

    await expect(
      extensionDeps!.createChildSession({ extensions: [] }),
    ).rejects.toBe(startupError);
    expect(child.close).toHaveBeenCalledOnce();
    await parent.close();
  });
});
