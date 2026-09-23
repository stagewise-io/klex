import { trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type { RootLogger } from '@stagewise/logger';

import type { Config } from '@/config';
import type { IntrospectionScope } from '@/introspection';
import type { SessionContext, SessionFactory } from '@/session/types';

import {
  type ChatSessionDependencies,
  createChatSession,
} from './chat-session';
import type {
  ExtensionDeps,
  ExtensionFactory,
} from './extensions/extension-api';

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});

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

function createScope(): IntrospectionScope {
  const scope: IntrospectionScope = {
    path: [],
    introspect: vi.fn(),
    child: vi.fn(() => createScope()),
    removeChild: vi.fn(),
  };
  return scope;
}

function sharedDeps(): Omit<
  ChatSessionDependencies,
  'sessionContext' | 'extensionFactories' | 'introspectionScope' | 'basePrompt'
> {
  return {
    logging,
    config,
    modelResolver: { resolveModelInfo: () => undefined } as never,
    dataDirectory: '/tmp/klex-chat-session-tracing-test',
    mcp: null,
  };
}

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`Missing ${what}`);
  return value;
}

const childFactory: SessionFactory = (params) =>
  createChatSession({
    ...sharedDeps(),
    mcp: params.mcp,
    sessionContext: params.sessionContext,
    extensionFactories: params.extensionFactories,
    introspectionScope: params.introspectionScope,
    basePrompt: params.basePrompt,
    parentSpanContext: params.parentSpanContext,
  });

describe('ChatSession tracing', () => {
  beforeAll(() => {
    trace.setGlobalTracerProvider(provider);
  });
  afterAll(async () => {
    await provider.shutdown();
    trace.disable();
  });
  beforeEach(() => exporter.reset());

  it('names main and extension-owned child session roots consistently', async () => {
    let extensionDeps: ExtensionDeps | undefined;
    const spawner: ExtensionFactory = {
      identifier: 'test/spawner',
      create: (deps) => {
        extensionDeps = deps;
        return {};
      },
    };
    const mainContext: SessionContext = {
      kind: 'default',
      name: 'main',
      sessionId: 'default',
    };
    const main = createChatSession({
      ...sharedDeps(),
      sessionContext: mainContext,
      extensionFactories: [spawner],
      introspectionScope: createScope(),
      sessionFactory: childFactory,
      basePrompt: '',
    });
    await main.start();

    const deps = required(extensionDeps, 'extension deps');
    const child = await deps.createChildSession({
      name: 'consult',
      extensionIdentifier: 'test/spawner',
      extensions: [],
      basePrompt: '',
    });
    await child.close();
    await main.close();

    const spans = exporter.getFinishedSpans();
    const mainSpan = required(
      spans.find((s) => s.name === 'session main'),
      'main session span',
    );
    const childSpan = required(
      spans.find((s) => s.name === 'session consult'),
      'child session span',
    );

    expect(mainSpan.attributes).toMatchObject({
      'klex.session.id': 'default',
      'klex.session.name': 'main',
      'klex.session.kind': 'default',
    });
    expect(childSpan.attributes).toMatchObject({
      'klex.session.id': child.sessionId,
      'klex.session.name': 'consult',
      'klex.session.kind': 'child',
      'klex.session.extension': 'test/spawner',
      'klex.session.parent.id': 'default',
    });

    // Separate trace, linked back to the spawning parent span.
    const mainCtx = mainSpan.spanContext();
    expect(childSpan.spanContext().traceId).not.toBe(mainCtx.traceId);
    expect(childSpan.parentSpanContext).toBeUndefined();
    expect(childSpan.links).toHaveLength(1);
    const link = required(childSpan.links[0], 'parent link');
    expect(link.context.traceId).toBe(mainCtx.traceId);
    expect(link.context.spanId).toBe(mainCtx.spanId);
    expect(link.attributes).toMatchObject({
      'klex.link.type': 'parent_session',
    });

    expect(
      mainSpan.events.find((e) => e.name === 'session.child_created')
        ?.attributes,
    ).toMatchObject({
      'klex.session.child.id': child.sessionId,
      'klex.session.child.name': 'consult',
      'klex.session.child.extension': 'test/spawner',
    });
  });
});
