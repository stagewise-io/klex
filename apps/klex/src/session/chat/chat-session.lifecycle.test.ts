import { describe, expect, it, vi } from 'vitest';

import type { RootLogger } from '@stagewise/logger';

import type { Config } from '@/config';
import type { IntrospectionScope } from '@/introspection';
import type { Mcp } from '@/mcp';
import type { ProductAnalyticsRecorder } from '@/product-analytics';
import type {
  ChatSessionHandle,
  ChildSessionHandle,
  SessionFactory,
} from '@/session/types';
import type { TelemetryMetrics } from '@/telemetry-metrics';

import { createChatSession } from './chat-session';
import type {
  ExtensionDeps,
  ExtensionFactory,
} from './extensions/extension-api';

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
    productAnalytics?: ProductAnalyticsRecorder;
    sessionFactory?: SessionFactory;
    telemetryMetrics?: TelemetryMetrics;
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
    sessionContext: { kind: 'default', name: 'main', sessionId: 'default' },
    sessionFactory: options.sessionFactory,
    telemetryMetrics: options.telemetryMetrics,
    productAnalytics: options.productAnalytics,
    basePrompt: 'You are Klex.',
  });
}

function fakeProductAnalytics() {
  const handle = { recordTurn: vi.fn(), close: vi.fn() };
  const recorder: ProductAnalyticsRecorder = {
    openSession: vi.fn(() => handle),
  };
  return { handle, recorder };
}

function requireExtensionDeps(
  extensionDeps: ExtensionDeps | undefined,
): ExtensionDeps {
  if (!extensionDeps)
    throw new Error('Extension dependencies were not captured');
  return extensionDeps;
}

function createFakeChild(
  start: () => Promise<void>,
): ChatSessionHandle & ChildSessionHandle {
  const child: ChatSessionHandle & ChildSessionHandle = {
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
    waitForIdle: vi.fn(async () => true),
    status: 'active',
  };
  return child;
}

describe('ChatSession lifecycle', () => {
  it('reports idle immediately when no loop is active', async () => {
    const session = createSession();

    await expect(session.waitForIdle(100)).resolves.toBe(true);
    await session.close();
  });

  it('reports non-idle after termination', async () => {
    const session = createSession();
    await session.close();

    await expect(session.waitForIdle(100)).resolves.toBe(false);
  });

  it('registers and unregisters session telemetry with stable labels', async () => {
    const registerSession = vi.fn();
    const unregisterSession = vi.fn();
    const session = createSession({
      telemetryMetrics: {
        registerSession,
        unregisterSession,
        recordSessionLifecycle: vi.fn(),
        recordSessionStateChange: vi.fn(),
      } as unknown as TelemetryMetrics,
    });

    expect(registerSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'default',
        name: 'main',
        kind: 'default',
        active: true,
      }),
    );

    await session.close();

    expect(unregisterSession).toHaveBeenCalledOnce();
    expect(unregisterSession).toHaveBeenCalledWith('default');
  });

  it('opens a product analytics handle and closes it on session close', async () => {
    const analytics = fakeProductAnalytics();
    const session = createSession({ productAnalytics: analytics.recorder });

    expect(analytics.recorder.openSession).toHaveBeenCalledOnce();
    expect(analytics.recorder.openSession).toHaveBeenCalledWith();
    expect(analytics.handle.close).not.toHaveBeenCalled();

    await session.close();
    await session.close();

    expect(analytics.handle.close).toHaveBeenCalledOnce();
    expect(analytics.handle.recordTurn).not.toHaveBeenCalled();
  });

  it('closes the product analytics handle when an extension close rejects', async () => {
    const analytics = fakeProductAnalytics();
    const extension: ExtensionFactory = {
      identifier: 'test/rejecting-close',
      create: () => ({
        onClose: vi.fn(async () => {
          throw new Error('extension close failed');
        }),
      }),
    };
    const session = createSession({
      extensions: [extension],
      productAnalytics: analytics.recorder,
    });

    await session.close().catch(() => undefined);

    expect(analytics.handle.close).toHaveBeenCalledOnce();
  });

  it('closes the product analytics handle when construction fails', () => {
    const analytics = fakeProductAnalytics();
    const extension: ExtensionFactory = {
      identifier: 'test/construction-failure',
      create: () => {
        throw new Error('extension construction failed');
      },
    };

    expect(() =>
      createSession({
        extensions: [extension],
        productAnalytics: analytics.recorder,
      }),
    ).toThrow('extension construction failed');
    expect(analytics.handle.close).toHaveBeenCalledOnce();
  });

  it('starts extensions and subscribes to MCP only once', async () => {
    const onStart = vi.fn(async () => undefined);
    const extension: ExtensionFactory = {
      identifier: 'test/lifecycle',
      create: () => ({ onStart }),
    };
    const session = createSession({
      extensions: [extension],
      mcp: {} as unknown as Mcp,
    });

    await Promise.all([session.start(), session.start()]);

    expect(onStart).toHaveBeenCalledOnce();

    await session.close();
    await expect(session.start()).rejects.toThrow(
      'Cannot start a terminated chat session',
    );
  });

  it('aborts generation and tools synchronously while cleanup is pending', async () => {
    const cleanup = Promise.withResolvers<void>();
    const extension: ExtensionFactory = {
      identifier: 'test/pending-cleanup',
      create: () => ({ onClose: vi.fn(() => cleanup.promise) }),
    };
    const session = createSession({ extensions: [extension] });
    const abortGeneration = vi.fn();
    const abortTools = vi.fn();
    (
      session as unknown as {
        currentTurn: {
          abortGeneration: (reason: string) => void;
          abortTools: () => void;
        };
      }
    ).currentTurn = { abortGeneration, abortTools };

    const closing = session.close();

    expect(abortGeneration).toHaveBeenCalledWith('session_shutdown');
    expect(abortTools).toHaveBeenCalledOnce();
    expect(() =>
      session.inbox.send({
        sourceEnv: 'test',
        urgency: 1,
        context: { sourceEnv: 'test', metadata: {}, content: [] },
      }),
    ).toThrow('Session inbox is closed');

    cleanup.resolve();
    await closing;
  });

  it('closes the inbox during termination and rejects stale delivery', async () => {
    const session = createSession({
      mcp: {} as unknown as Mcp,
    });
    await session.start();

    await session.close();

    expect(() =>
      session.inbox.send({
        sourceEnv: 'test',
        urgency: 1,
        context: { sourceEnv: 'test', metadata: {}, content: [] },
      }),
    ).toThrow('Session inbox is closed');
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
      mcp: {} as unknown as Mcp,
      sessionFactory,
    });
    await parent.start();

    let resolved = false;
    const creation = requireExtensionDeps(extensionDeps)
      .createChildSession({
        name: 'test-child',
        extensionIdentifier: 'test-extension',
        extensions: [childExtension],
        basePrompt: 'You are a child.',
        modelPurpose: 'memory',
      })
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
    expect(childParams?.modelPurpose).toBe('memory');

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
      sessionFactory: () => child,
    });
    await parent.start();

    const creation = requireExtensionDeps(extensionDeps).createChildSession({
      name: 'test-child',
      extensionIdentifier: 'test-extension',
      extensions: [],
      basePrompt: 'You are a child.',
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
        name: 'test-child',
        extensionIdentifier: 'test-extension',
        extensions: [],
        basePrompt: 'You are a child.',
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
        sessionContext: {
          kind: 'child',
          name: 'failed-child',
          sessionId: 'failed-child',
        },
        basePrompt: 'You are Klex.',
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
        name: 'test-child',
        extensionIdentifier: 'test-extension',
        extensions: [],
        basePrompt: 'You are a child.',
      }),
    ).rejects.toBe(startupError);
    expect(child.close).toHaveBeenCalledOnce();
    await parent.close();
  });
});
