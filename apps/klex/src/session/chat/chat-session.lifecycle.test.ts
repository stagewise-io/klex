import { describe, expect, it, vi } from 'vitest';

import type { RootLogger } from '@stagewise/logger';

import type { Config } from '@/config';
import type { IntrospectionScope } from '@/introspection';
import type { Mcp, McpPushNotification } from '@/mcp';
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

function requireExtensionDeps(
  extensionDeps: ExtensionDeps | undefined,
): ExtensionDeps {
  if (!extensionDeps)
    throw new Error('Extension dependencies were not captured');
  return extensionDeps;
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

  it('unsubscribes before closing the inbox and rejects stale MCP delivery', async () => {
    const listenerRef: {
      current?: (event: McpPushNotification) => void | Promise<void>;
    } = {};
    const notification: McpPushNotification = {
      namespace: 'local',
      event: {
        eventId: 'event-1',
        sourceId: 'chat:user',
        type: 'chat.message.received',
        createdAt: '2026-07-20T10:30:00.000Z',
        content: [{ type: 'text', text: 'hello' }],
      },
    };
    const deliveryDuringUnsubscribe = vi.fn();
    const session = createSession({
      mcp: {
        onPushNotification: vi.fn((callback) => {
          listenerRef.current = callback;
          return () => {
            callback(notification);
            deliveryDuringUnsubscribe();
          };
        }),
      } as unknown as Mcp,
    });
    await session.start();

    await session.close();

    expect(deliveryDuringUnsubscribe).toHaveBeenCalledOnce();
    const staleListener = listenerRef.current;
    if (!staleListener) throw new Error('MCP listener was not registered');
    expect(() => staleListener(notification)).toThrow(
      'Session inbox is closed',
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
      mcp: {
        onPushNotification: vi.fn(() => vi.fn()),
      } as unknown as Mcp,
      sessionFactory,
    });
    await parent.start();

    let resolved = false;
    const creation = requireExtensionDeps(extensionDeps)
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

  it('closes a child whose startup outlives its parent', async () => {
    let extensionDeps: ExtensionDeps | undefined;
    const extension: ExtensionFactory = {
      identifier: 'test/parent',
      create: (deps) => {
        extensionDeps = deps;
        return {};
      },
    };
    const startup = Promise.withResolvers<void>();
    const child = createFakeChild(() => startup.promise);
    const parent = createSession({
      extensions: [extension],
      sessionFactory: () => child as unknown as ChatSessionHandle,
    });
    await parent.start();

    const creation = requireExtensionDeps(extensionDeps).createChildSession({
      extensions: [],
    });
    await Promise.resolve();
    await parent.close();

    expect(child.close).not.toHaveBeenCalled();
    startup.resolve();
    await expect(creation).rejects.toThrow(
      'Parent chat session terminated while child session was starting',
    );
    expect(child.close).toHaveBeenCalledOnce();
  });

  it('rejects child creation after the parent terminates', async () => {
    let extensionDeps: ExtensionDeps | undefined;
    const extension: ExtensionFactory = {
      identifier: 'test/parent',
      create: (deps) => {
        extensionDeps = deps;
        return {};
      },
    };
    const sessionFactory = vi.fn();
    const parent = createSession({ extensions: [extension], sessionFactory });
    await parent.start();
    await parent.close();

    await expect(
      requireExtensionDeps(extensionDeps).createChildSession({
        extensions: [],
      }),
    ).rejects.toThrow('Cannot create a child from a terminated chat session');
    expect(sessionFactory).not.toHaveBeenCalled();
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
      requireExtensionDeps(extensionDeps).createChildSession({
        extensions: [],
      }),
    ).rejects.toBe(startupError);
    expect(child.close).toHaveBeenCalledOnce();
    await parent.close();
  });
});
