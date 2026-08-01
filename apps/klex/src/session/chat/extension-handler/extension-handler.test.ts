import { context, trace } from '@opentelemetry/api';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import type { ModelMessage, ToolSet } from 'ai';
import { tool } from 'ai';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type {
  BaseExtensionDeps,
  DataPartTransformers,
  Extension,
  ExtensionDeps,
  ExtensionFactory,
  GenerateTextArgs,
  GenerateTextResult,
  ResolvedModel,
  StepCompleteEvent,
} from '../extensions/extension-api';
import type { ExtendedUIMessage } from '../message-types';
import { getExtensionIdentifier } from '../utils/tracing';
import { createExtensionHandler } from './extension-handler';

// --- OTel setup for trace-attribution tests ---
//
// The default NoopContextManager does not propagate context across
// `context.with` blocks. Register a real AsyncHooksContextManager so
// that context propagation (used by the generateText wrapper to set the
// extension identifier) works in tests.
let contextManager: AsyncHooksContextManager | undefined;

beforeAll(() => {
  contextManager = new AsyncHooksContextManager();
  contextManager.enable();
  context.setGlobalContextManager(contextManager);

  // Register a basic tracer provider so that `context.with` with a span
  // context does not throw when the tracer is accessed.
  const provider = new BasicTracerProvider();
  trace.setGlobalTracerProvider(provider);
});

afterAll(() => {
  contextManager?.disable();
});

// --- fixtures ---

const noopDeps: BaseExtensionDeps = {
  getHistory: () => [],
  insertMessageAfter: vi.fn(() => true),
  inbox: {
    send: vi.fn(),
    sendMessage: vi.fn(),
    close: vi.fn(),
  },
  config: { get: () => ({}) } as unknown as BaseExtensionDeps['config'],
  generateText: vi.fn(() =>
    Promise.resolve({
      success: false as const,
      failureReason: 'no-models' as const,
    }),
  ),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  } as unknown as BaseExtensionDeps['logger'],
  logging: {
    child: () => noopDeps.logger,
  } as unknown as BaseExtensionDeps['logging'],
  mcp: {} as unknown as BaseExtensionDeps['mcp'],
  sessionId: 'test-session-id',
};

const HANDLER_OPTS = {
  extensionDeps: noopDeps,
  dataDirectory: '/tmp/test-agent-data',
  sessionId: 'session-123',
};

const mockResolvedModel: ResolvedModel = {
  modelId: 'remote:gpt-4o',
  displayName: 'GPT-4o',
  contextSize: 128_000,
  inputCapabilities: {},
};

function makeMessage(text: string): ExtendedUIMessage {
  return {
    id: `msg-${text}`,
    role: 'user',
    parts: [{ type: 'text', text }],
  } as ExtendedUIMessage;
}

let factoryIdCounter = 0;

/** Creates a factory that returns a partial extension with spied hooks. */
function factoryWith(
  overrides: Partial<Extension> & { _spy?: boolean } = {},
): ExtensionFactory {
  const id = `test.example/ext-${++factoryIdCounter}`;
  return {
    identifier: id,
    create: () => ({
      onStart: overrides.onStart,
      onClose: overrides.onClose,
      getTools: overrides.getTools,
      onStepStart: overrides.onStepStart,
      historyTransformer: overrides.historyTransformer,
      contextTransformer: overrides.contextTransformer,
      onStepComplete: overrides.onStepComplete,
      dataPartTransformers: overrides.dataPartTransformers,
    }),
  };
}

// --- tests ---

describe('ExtensionHandler — factory', () => {
  it('returns an object implementing ExtensionHandler', () => {
    const handler = createExtensionHandler({
      factories: [],
      ...HANDLER_OPTS,
    });
    expect(typeof handler.runHistoryTransformers).toBe('function');
    expect(typeof handler.runContextTransformers).toBe('function');
    expect(typeof handler.getDataPartTransformers).toBe('function');
    expect(typeof handler.runStepCompleteHooks).toBe('function');
  });

  it('instantiates all extensions from the provided factories', () => {
    const f1 = factoryWith({});
    const f2 = factoryWith({});
    const create1 = vi.fn(f1.create);
    const create2 = vi.fn(f2.create);

    createExtensionHandler({
      factories: [
        { identifier: f1.identifier, create: create1 },
        { identifier: f2.identifier, create: create2 },
      ],
      ...HANDLER_OPTS,
    });

    expect(create1).toHaveBeenCalledOnce();
    expect(create2).toHaveBeenCalledOnce();
    // Each factory receives deps that include getDataDir
    const deps1 = create1.mock.calls[0]![0];
    expect(typeof deps1.getDataDir).toBe('function');
  });

  it('exposes the instantiated extensions as a readonly array', () => {
    const handler = createExtensionHandler({
      factories: [factoryWith({}), factoryWith({})],
      ...HANDLER_OPTS,
    });
    expect(handler.extensions).toHaveLength(2);
  });

  it('works with zero factories', () => {
    const handler = createExtensionHandler({
      factories: [],
      ...HANDLER_OPTS,
    });
    expect(handler.extensions).toHaveLength(0);
  });

  it('throws on duplicate extension identifiers', () => {
    const dup: ExtensionFactory = {
      identifier: 'io.stagewise/duplicate',
      create: () => ({}),
    };
    expect(() =>
      createExtensionHandler({
        factories: [dup, dup],
        ...HANDLER_OPTS,
      }),
    ).toThrow(/Duplicate extension identifier/);
  });

  it('provides session-scoped getDataDir by default', () => {
    let receivedDeps: ExtensionDeps | null = null;
    const factory: ExtensionFactory = {
      identifier: 'io.stagewise/getdatadir-test',
      create: (deps) => {
        receivedDeps = deps;
        return {};
      },
    };
    createExtensionHandler({
      factories: [factory],
      ...HANDLER_OPTS,
    });
    expect(receivedDeps!.getDataDir()).toBe(
      '/tmp/test-agent-data/sessions/session-123/extensions/io.stagewise/getdatadir-test',
    );
  });

  it('provides global getDataDir when global=true', () => {
    let receivedDeps: ExtensionDeps | null = null;
    const factory: ExtensionFactory = {
      identifier: 'io.stagewise/getdatadir-global',
      create: (deps) => {
        receivedDeps = deps;
        return {};
      },
    };
    createExtensionHandler({
      factories: [factory],
      ...HANDLER_OPTS,
    });
    expect(receivedDeps!.getDataDir(true)).toBe(
      '/tmp/test-agent-data/extensions/io.stagewise/getdatadir-global',
    );
  });
});

describe('ExtensionHandler — runHistoryTransformers', () => {
  it('returns the history unchanged with empty flags when no extensions define the hook', async () => {
    const handler = createExtensionHandler({
      factories: [factoryWith({})],
      ...HANDLER_OPTS,
    });
    const history = [makeMessage('a')];
    const result = await handler.runHistoryTransformers(
      history,
      mockResolvedModel,
    );
    expect(result.history).toEqual(history);
    expect(result.flags).toEqual({});
  });

  it('calls the hook on each extension in order', async () => {
    const hook1 = vi.fn((h: ExtendedUIMessage[]) => [
      ...h,
      makeMessage('ext1'),
    ]);
    const hook2 = vi.fn((h: ExtendedUIMessage[]) => [
      ...h,
      makeMessage('ext2'),
    ]);

    const handler = createExtensionHandler({
      factories: [
        factoryWith({ historyTransformer: hook1 }),
        factoryWith({ historyTransformer: hook2 }),
      ],
      ...HANDLER_OPTS,
    });

    const result = await handler.runHistoryTransformers(
      [makeMessage('orig')],
      mockResolvedModel,
    );

    expect(hook1).toHaveBeenCalledExactlyOnceWith(
      [makeMessage('orig')],
      mockResolvedModel,
    );
    expect(hook2).toHaveBeenCalledExactlyOnceWith(
      [makeMessage('orig'), makeMessage('ext1')],
      mockResolvedModel,
    );
    expect(result.history).toEqual([
      makeMessage('orig'),
      makeMessage('ext1'),
      makeMessage('ext2'),
    ]);
    expect(result.flags).toEqual({});
  });

  it('skips extensions that do not define the hook', async () => {
    const hook1 = vi.fn((h: ExtendedUIMessage[]) => h);
    const hook3 = vi.fn((h: ExtendedUIMessage[]) => [
      ...h,
      makeMessage('ext3'),
    ]);

    const handler = createExtensionHandler({
      factories: [
        factoryWith({ historyTransformer: hook1 }),
        factoryWith({}), // no hook
        factoryWith({ historyTransformer: hook3 }),
      ],
      ...HANDLER_OPTS,
    });

    await handler.runHistoryTransformers(
      [makeMessage('orig')],
      mockResolvedModel,
    );

    expect(hook1).toHaveBeenCalledOnce();
    expect(hook3).toHaveBeenCalledOnce();
  });

  it('supports async hooks', async () => {
    const hook = vi.fn(async (h: ExtendedUIMessage[]) => [
      ...h,
      makeMessage('async'),
    ]);

    const handler = createExtensionHandler({
      factories: [factoryWith({ historyTransformer: hook })],
      ...HANDLER_OPTS,
    });

    const result = await handler.runHistoryTransformers(
      [makeMessage('orig')],
      mockResolvedModel,
    );
    expect(result.history).toEqual([makeMessage('orig'), makeMessage('async')]);
  });

  it('normalizes shorthand return (array only) into { history, flags }', async () => {
    const hook = vi.fn((h: ExtendedUIMessage[]) => h);
    const handler = createExtensionHandler({
      factories: [factoryWith({ historyTransformer: hook })],
      ...HANDLER_OPTS,
    });
    const history = [makeMessage('a')];
    const result = await handler.runHistoryTransformers(
      history,
      mockResolvedModel,
    );
    expect(result.history).toBe(history);
    expect(result.flags).toEqual({});
  });

  it('logs and re-throws errors from a failing transformer, aborting the pipeline', async () => {
    const hook1 = vi.fn((h: ExtendedUIMessage[]) => [
      ...h,
      makeMessage('ext1'),
    ]);
    const hook2 = vi.fn(() => {
      throw new Error('historyTransformer failed');
    });
    const hook3 = vi.fn((h: ExtendedUIMessage[]) => [
      ...h,
      makeMessage('ext3'),
    ]);

    const handler = createExtensionHandler({
      factories: [
        factoryWith({ historyTransformer: hook1 }),
        factoryWith({ historyTransformer: hook2 }),
        factoryWith({ historyTransformer: hook3 }),
      ],
      ...HANDLER_OPTS,
    });

    await expect(
      handler.runHistoryTransformers([makeMessage('orig')], mockResolvedModel),
    ).rejects.toThrow('historyTransformer failed');

    expect(hook1).toHaveBeenCalledOnce();
    expect(hook2).toHaveBeenCalledOnce();
    // hook3 never runs — pipeline aborts on the first error.
    expect(hook3).not.toHaveBeenCalled();
    expect(noopDeps.logger.error).toHaveBeenCalled();
  });

  it('merges hasCompacted flags across extensions (OR semantics)', async () => {
    const hook1 = vi.fn((h: ExtendedUIMessage[]) => ({
      history: h,
      flags: { hasCompacted: true },
    }));
    const hook2 = vi.fn((h: ExtendedUIMessage[]) => ({
      history: h,
      flags: { hasCompacted: false },
    }));

    const handler = createExtensionHandler({
      factories: [
        factoryWith({ historyTransformer: hook1 }),
        factoryWith({ historyTransformer: hook2 }),
      ],
      ...HANDLER_OPTS,
    });

    const result = await handler.runHistoryTransformers(
      [makeMessage('a')],
      mockResolvedModel,
    );
    expect(result.flags.hasCompacted).toBe(true);
  });

  it('forwards the ResolvedModel argument to each extension transformer', async () => {
    const hook = vi.fn((h: ExtendedUIMessage[]) => h);
    const handler = createExtensionHandler({
      factories: [factoryWith({ historyTransformer: hook })],
      ...HANDLER_OPTS,
    });

    await handler.runHistoryTransformers([makeMessage('a')], mockResolvedModel);

    expect(hook).toHaveBeenCalledExactlyOnceWith(
      [makeMessage('a')],
      mockResolvedModel,
    );
  });
});

describe('ExtensionHandler — runContextTransformers', () => {
  it('returns the history unchanged with empty flags when no extensions define the hook', async () => {
    const handler = createExtensionHandler({
      factories: [factoryWith({})],
      ...HANDLER_OPTS,
    });
    const history: ModelMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'a' }] },
    ];
    const result = await handler.runContextTransformers(
      history,
      mockResolvedModel,
    );
    expect(result.history).toEqual(history);
    expect(result.flags).toEqual({});
  });

  it('calls the hook on each extension in order, chaining outputs', async () => {
    const hook1 = vi.fn((h: ModelMessage[]) => [
      ...h,
      {
        role: 'user',
        content: [{ type: 'text', text: 'ext1' }],
      } as ModelMessage,
    ]);
    const hook2 = vi.fn((h: ModelMessage[]) => [
      ...h,
      {
        role: 'user',
        content: [{ type: 'text', text: 'ext2' }],
      } as ModelMessage,
    ]);

    const handler = createExtensionHandler({
      factories: [
        factoryWith({ contextTransformer: hook1 }),
        factoryWith({ contextTransformer: hook2 }),
      ],
      ...HANDLER_OPTS,
    });

    const result = await handler.runContextTransformers(
      [
        { role: 'user', content: [{ type: 'text', text: 'orig' }] },
      ] as ModelMessage[],
      mockResolvedModel,
    );

    expect(result.history).toHaveLength(3);
    expect(result.flags).toEqual({});
    expect(hook1).toHaveBeenCalledOnce();
    expect(hook2).toHaveBeenCalledOnce();
  });

  it('skips extensions that do not define the hook', async () => {
    const hook1 = vi.fn((h: ModelMessage[]) => h);

    const handler = createExtensionHandler({
      factories: [
        factoryWith({ contextTransformer: hook1 }),
        factoryWith({}), // no hook
      ],
      ...HANDLER_OPTS,
    });

    await handler.runContextTransformers(
      [
        { role: 'user', content: [{ type: 'text', text: 'a' }] },
      ] as ModelMessage[],
      mockResolvedModel,
    );

    expect(hook1).toHaveBeenCalledOnce();
  });

  it('logs and re-throws errors from a failing transformer, aborting the pipeline', async () => {
    const hook1 = vi.fn((h: ModelMessage[]) => [
      ...h,
      {
        role: 'user',
        content: [{ type: 'text', text: 'ext1' }],
      } as ModelMessage,
    ]);
    const hook2 = vi.fn(() => {
      throw new Error('contextTransformer failed');
    });
    const hook3 = vi.fn((h: ModelMessage[]) => [
      ...h,
      {
        role: 'user',
        content: [{ type: 'text', text: 'ext3' }],
      } as ModelMessage,
    ]);

    const handler = createExtensionHandler({
      factories: [
        factoryWith({ contextTransformer: hook1 }),
        factoryWith({ contextTransformer: hook2 }),
        factoryWith({ contextTransformer: hook3 }),
      ],
      ...HANDLER_OPTS,
    });

    await expect(
      handler.runContextTransformers(
        [
          { role: 'user', content: [{ type: 'text', text: 'orig' }] },
        ] as ModelMessage[],
        mockResolvedModel,
      ),
    ).rejects.toThrow('contextTransformer failed');

    expect(hook1).toHaveBeenCalledOnce();
    expect(hook2).toHaveBeenCalledOnce();
    // hook3 never runs — pipeline aborts on the first error.
    expect(hook3).not.toHaveBeenCalled();
    expect(noopDeps.logger.error).toHaveBeenCalled();
  });

  it('forwards the ResolvedModel argument to each extension transformer', async () => {
    const hook = vi.fn((h: ModelMessage[]) => h);
    const handler = createExtensionHandler({
      factories: [factoryWith({ contextTransformer: hook })],
      ...HANDLER_OPTS,
    });

    await handler.runContextTransformers(
      [
        { role: 'user', content: [{ type: 'text', text: 'a' }] },
      ] as ModelMessage[],
      mockResolvedModel,
    );

    expect(hook).toHaveBeenCalledExactlyOnceWith(
      [
        { role: 'user', content: [{ type: 'text', text: 'a' }] },
      ] as ModelMessage[],
      mockResolvedModel,
    );
  });
});

describe('ExtensionHandler — getDataPartTransformers', () => {
  it('returns an empty object when no extensions define transformers', () => {
    const handler = createExtensionHandler({
      factories: [factoryWith({}), factoryWith({})],
      ...HANDLER_OPTS,
    });
    expect(handler.getDataPartTransformers()).toEqual({});
  });

  it('merges transformers from multiple extensions', () => {
    const transformer1 = vi.fn(() => [{ type: 'text' as const, text: 'ctx' }]);
    const transformer2 = vi.fn(() => [
      { type: 'text' as const, text: 'summary' },
    ]);

    const transformers1 = {
      context: transformer1,
    } as unknown as DataPartTransformers;
    const transformers2 = {
      'context-summary': transformer2,
    } as unknown as DataPartTransformers;

    const handler = createExtensionHandler({
      factories: [
        factoryWith({ dataPartTransformers: transformers1 }),
        factoryWith({ dataPartTransformers: transformers2 }),
      ],
      ...HANDLER_OPTS,
    });

    const merged = handler.getDataPartTransformers();
    expect(merged.context).toBe(transformer1);
    expect(merged['context-summary']).toBe(transformer2);
  });

  it('throws when two extensions register a transformer for the same type', () => {
    const transformer1 = vi.fn(() => [{ type: 'text' as const, text: 'a' }]);
    const transformer2 = vi.fn(() => [{ type: 'text' as const, text: 'b' }]);

    const transformers1 = {
      context: transformer1,
    } as unknown as DataPartTransformers;
    const transformers2 = {
      context: transformer2,
    } as unknown as DataPartTransformers;

    const handler = createExtensionHandler({
      factories: [
        factoryWith({ dataPartTransformers: transformers1 }),
        factoryWith({ dataPartTransformers: transformers2 }),
      ],
      ...HANDLER_OPTS,
    });

    expect(() => handler.getDataPartTransformers()).toThrow(
      /Duplicate data part transformer for type "context"/,
    );
  });

  it('can be called multiple times (idempotent read)', () => {
    const transformer = vi.fn(() => [{ type: 'text' as const, text: 'x' }]);
    const transformers = {
      context: transformer,
    } as unknown as DataPartTransformers;

    const handler = createExtensionHandler({
      factories: [factoryWith({ dataPartTransformers: transformers })],
      ...HANDLER_OPTS,
    });

    const first = handler.getDataPartTransformers();
    const second = handler.getDataPartTransformers();
    expect(first).toEqual(second);
  });
});

describe('ExtensionHandler — runStepStartHooks', () => {
  it('returns void when no extensions define the hook', async () => {
    const handler = createExtensionHandler({
      factories: [factoryWith({})],
      ...HANDLER_OPTS,
    });
    await expect(handler.runStepStartHooks()).resolves.toBeUndefined();
  });

  it('calls onStepStart on each extension that defines it', async () => {
    const hook1 = vi.fn(() => {});
    const hook2 = vi.fn(() => {});

    const handler = createExtensionHandler({
      factories: [
        factoryWith({ onStepStart: hook1 }),
        factoryWith({ onStepStart: hook2 }),
      ],
      ...HANDLER_OPTS,
    });

    await handler.runStepStartHooks();

    expect(hook1).toHaveBeenCalledOnce();
    expect(hook2).toHaveBeenCalledOnce();
  });

  it('skips extensions that do not define the hook', async () => {
    const hook1 = vi.fn(() => {});
    const hook3 = vi.fn(() => {});

    const handler = createExtensionHandler({
      factories: [
        factoryWith({ onStepStart: hook1 }),
        factoryWith({}),
        factoryWith({ onStepStart: hook3 }),
      ],
      ...HANDLER_OPTS,
    });

    await handler.runStepStartHooks();

    expect(hook1).toHaveBeenCalledOnce();
    expect(hook3).toHaveBeenCalledOnce();
  });

  it('supports async hooks', async () => {
    const hook = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const handler = createExtensionHandler({
      factories: [factoryWith({ onStepStart: hook })],
      ...HANDLER_OPTS,
    });

    await handler.runStepStartHooks();
    expect(hook).toHaveBeenCalledOnce();
  });

  it('catches and logs errors from individual extensions without breaking other hooks', async () => {
    vi.clearAllMocks();
    const hook1 = vi.fn(() => {
      throw new Error('hook1 failed');
    });
    const hook2 = vi.fn(() => {});

    const handler = createExtensionHandler({
      factories: [
        factoryWith({ onStepStart: hook1 }),
        factoryWith({ onStepStart: hook2 }),
      ],
      ...HANDLER_OPTS,
    });

    await handler.runStepStartHooks();

    expect(hook1).toHaveBeenCalledOnce();
    expect(hook2).toHaveBeenCalledOnce();
    expect(noopDeps.logger.error).toHaveBeenCalled();
  });

  it('preserves `this` binding for class-based extensions', async () => {
    vi.clearAllMocks();

    class StatefulExtension implements Extension {
      readonly identifier = 'test.example/start-stateful';
      readonly displayName = 'StartStateful';
      private stepCount = 0;

      onStepStart() {
        this.stepCount++;
      }

      getStepCount() {
        return this.stepCount;
      }
    }

    const ext = new StatefulExtension();
    const factory: ExtensionFactory = {
      identifier: 'test.example/start-stateful',
      create: () => ext,
    };

    const handler = createExtensionHandler({
      factories: [factory],
      ...HANDLER_OPTS,
    });

    await handler.runStepStartHooks();
    await handler.runStepStartHooks();

    expect(ext.getStepCount()).toBe(2);
    expect(noopDeps.logger.error).not.toHaveBeenCalled();
  });
});

describe('ExtensionHandler — runStepCompleteHooks', () => {
  const stepEvent: StepCompleteEvent = {
    shouldContinue: true,
    forceNextStep: false,
    fatalError: false,
    fatalErrorReason: null,
    generationFailed: false,
    generation: {
      modelId: 'test-model',
      finishReason: 'stop',
      usage: {
        inputTokens: 100,
        outputTokens: 50,
      } as never,
    },
    toolCalls: [],
    modelFallbackOccurred: false,
  };

  it('resolves with void when no extensions define the hook', async () => {
    const handler = createExtensionHandler({
      factories: [factoryWith({})],
      ...HANDLER_OPTS,
    });
    await expect(
      handler.runStepCompleteHooks(stepEvent),
    ).resolves.toBeUndefined();
  });

  it('calls onStepComplete on each extension', async () => {
    const hook1 = vi.fn(() => {});
    const hook2 = vi.fn(() => {});

    const handler = createExtensionHandler({
      factories: [
        factoryWith({ onStepComplete: hook1 }),
        factoryWith({ onStepComplete: hook2 }),
      ],
      ...HANDLER_OPTS,
    });

    await handler.runStepCompleteHooks(stepEvent);

    // Each hook receives a structured clone with the same values.
    expect(hook1).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining(stepEvent),
    );
    expect(hook2).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining(stepEvent),
    );
  });

  it('skips extensions that do not define the hook', async () => {
    const hook1 = vi.fn(() => {});
    const hook3 = vi.fn(() => {});

    const handler = createExtensionHandler({
      factories: [
        factoryWith({ onStepComplete: hook1 }),
        factoryWith({}),
        factoryWith({ onStepComplete: hook3 }),
      ],
      ...HANDLER_OPTS,
    });

    await handler.runStepCompleteHooks(stepEvent);

    expect(hook1).toHaveBeenCalledOnce();
    expect(hook3).toHaveBeenCalledOnce();
  });

  it('supports async hooks', async () => {
    const hook = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const handler = createExtensionHandler({
      factories: [factoryWith({ onStepComplete: hook })],
      ...HANDLER_OPTS,
    });

    await handler.runStepCompleteHooks(stepEvent);
    expect(hook).toHaveBeenCalledOnce();
  });

  it('passes a structured clone so extensions cannot mutate the original event or affect following extensions', async () => {
    const hook1 = vi.fn((event: StepCompleteEvent) => {
      // Mutate both top-level and nested fields. A shallow copy would
      // leak the nested mutation to the original and to hook2.
      event.shouldContinue = false;
      event.generation!.usage.inputTokens = 999;
      event.generation!.usage.outputTokens = 999;
    });
    const hook2 = vi.fn((event: StepCompleteEvent) => {
      // Should see the original, unmutated values — including nested.
      expect(event.shouldContinue).toBe(true);
      expect(event.generation!.usage).toEqual({
        inputTokens: 100,
        outputTokens: 50,
      });
    });

    const handler = createExtensionHandler({
      factories: [
        factoryWith({ onStepComplete: hook1 }),
        factoryWith({ onStepComplete: hook2 }),
      ],
      ...HANDLER_OPTS,
    });

    await handler.runStepCompleteHooks(stepEvent);

    // The original object passed to the handler is unmutated.
    expect(stepEvent.shouldContinue).toBe(true);
    expect(stepEvent.generation!.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(hook1).toHaveBeenCalledOnce();
    expect(hook2).toHaveBeenCalledOnce();
  });

  it('catches and logs errors from individual extensions without breaking other hooks', async () => {
    const hook1 = vi.fn(() => {
      throw new Error('hook1 failed');
    });
    const hook2 = vi.fn(() => {});

    const handler = createExtensionHandler({
      factories: [
        factoryWith({ onStepComplete: hook1 }),
        factoryWith({ onStepComplete: hook2 }),
      ],
      ...HANDLER_OPTS,
    });

    await handler.runStepCompleteHooks(stepEvent);

    expect(hook1).toHaveBeenCalledOnce();
    expect(hook2).toHaveBeenCalledOnce();
    expect(noopDeps.logger.error).toHaveBeenCalled();
  });

  it('preserves `this` binding for class-based extensions', async () => {
    // Regression: extracting the method reference (ext.onStepComplete)
    // and calling it as a bare function loses `this`, causing
    // "Cannot read properties of undefined" for any extension that
    // relies on instance state.
    vi.clearAllMocks();

    class StatefulExtension implements Extension {
      readonly identifier = 'test.example/stateful';
      readonly displayName = 'Stateful';
      private accumulatedTokens = 0;

      onStepComplete(event: StepCompleteEvent) {
        const usage = event.generation?.usage;
        if (usage) {
          this.accumulatedTokens +=
            (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
        }
      }

      getAccumulatedTokens() {
        return this.accumulatedTokens;
      }
    }

    const ext = new StatefulExtension();
    const factory: ExtensionFactory = {
      identifier: 'test.example/stateful',
      create: () => ext,
    };

    const handler = createExtensionHandler({
      factories: [factory],
      ...HANDLER_OPTS,
    });

    await handler.runStepCompleteHooks(stepEvent);

    // If `this` was undefined, onStepComplete would have thrown and
    // accumulatedTokens would still be 0.
    expect(ext.getAccumulatedTokens()).toBe(150);
    expect(noopDeps.logger.error).not.toHaveBeenCalled();
  });
});

describe('ExtensionHandler — generateText wrapper trace attribution', () => {
  /**
   * Builds a fresh set of deps with a spied generateText that captures
   * the extension identifier from the OTel context at call time.
   */
  function depsWithCapture(): {
    deps: BaseExtensionDeps;
    capturedIds: () => (string | undefined)[];
    generateTextSpy: ReturnType<typeof vi.fn>;
  } {
    const captured: (string | undefined)[] = [];
    const generateTextSpy = vi.fn((_args: GenerateTextArgs) => {
      captured.push(getExtensionIdentifier());
      return Promise.resolve({
        success: true as const,
        text: 'ok',
        modelId: 'test-model',
        usage: { inputTokens: 10, outputTokens: 5 },
      });
    });
    const deps: BaseExtensionDeps = {
      ...noopDeps,
      generateText:
        generateTextSpy as unknown as BaseExtensionDeps['generateText'],
    };
    return { deps, capturedIds: () => captured, generateTextSpy };
  }

  it('sets the extension identifier in the OTel context for generateText calls', async () => {
    const { deps, capturedIds } = depsWithCapture();

    let receivedDeps: ExtensionDeps | null = null;
    const factory: ExtensionFactory = {
      identifier: 'io.stagewise/trace-test',
      create: (d) => {
        receivedDeps = d;
        return {};
      },
    };

    createExtensionHandler({
      factories: [factory],
      extensionDeps: deps,
      dataDirectory: '/tmp/test',
      sessionId: 's1',
    });

    await receivedDeps!.generateText({
      modelIds: ['test:model'],
      prompt: 'hello',
    });

    expect(capturedIds()).toEqual(['io.stagewise/trace-test']);
  });

  it('does not leak the identifier outside the generateText call', async () => {
    const { deps } = depsWithCapture();

    let receivedDeps: ExtensionDeps | null = null;
    const factory: ExtensionFactory = {
      identifier: 'io.stagewise/no-leak',
      create: (d) => {
        receivedDeps = d;
        return {};
      },
    };

    createExtensionHandler({
      factories: [factory],
      extensionDeps: deps,
      dataDirectory: '/tmp/test',
      sessionId: 's1',
    });

    // Before the call — no identifier in the ambient context.
    expect(getExtensionIdentifier()).toBeUndefined();

    await receivedDeps!.generateText({
      modelIds: ['test:model'],
      prompt: 'hello',
    });

    // After the call — still no identifier in the ambient context.
    expect(getExtensionIdentifier()).toBeUndefined();
  });

  it('sets the correct identifier per extension when multiple extensions call generateText', async () => {
    const { deps, capturedIds } = depsWithCapture();

    const depsMap = new Map<string, ExtensionDeps>();
    const makeFactory = (id: string): ExtensionFactory => ({
      identifier: id,
      create: (d) => {
        depsMap.set(id, d);
        return {};
      },
    });

    createExtensionHandler({
      factories: [
        makeFactory('io.stagewise/ext-a'),
        makeFactory('io.stagewise/ext-b'),
      ],
      extensionDeps: deps,
      dataDirectory: '/tmp/test',
      sessionId: 's1',
    });

    // Call generateText from ext-a, then ext-b.
    await depsMap.get('io.stagewise/ext-a')!.generateText({
      modelIds: ['test:a'],
      prompt: 'a',
    });
    await depsMap.get('io.stagewise/ext-b')!.generateText({
      modelIds: ['test:b'],
      prompt: 'b',
    });

    expect(capturedIds()).toEqual(['io.stagewise/ext-a', 'io.stagewise/ext-b']);
  });

  it('passes the original args through to the underlying generateText unchanged', async () => {
    const { deps, generateTextSpy } = depsWithCapture();

    let receivedDeps: ExtensionDeps | null = null;
    const factory: ExtensionFactory = {
      identifier: 'io.stagewise/args-passthrough',
      create: (d) => {
        receivedDeps = d;
        return {};
      },
    };

    createExtensionHandler({
      factories: [factory],
      extensionDeps: deps,
      dataDirectory: '/tmp/test',
      sessionId: 's1',
    });

    const args: GenerateTextArgs = {
      modelIds: ['test:model-1', 'test:model-2'],
      system: 'you are a test',
      prompt: 'say hello',
      temperature: 0.7,
      maxOutputTokens: 100,
    };

    await receivedDeps!.generateText(args);

    expect(generateTextSpy).toHaveBeenCalledExactlyOnceWith(args);
  });

  it('still invokes onExtensionUsage on success', async () => {
    const onExtensionUsage = vi.fn();
    const { deps } = depsWithCapture();

    let receivedDeps: ExtensionDeps | null = null;
    const factory: ExtensionFactory = {
      identifier: 'io.stagewise/usage-test',
      create: (d) => {
        receivedDeps = d;
        return {};
      },
    };

    createExtensionHandler({
      factories: [factory],
      extensionDeps: deps,
      dataDirectory: '/tmp/test',
      sessionId: 's1',
      onExtensionUsage,
    });

    await receivedDeps!.generateText({
      modelIds: ['test:m'],
      prompt: 'hi',
    });

    expect(onExtensionUsage).toHaveBeenCalledExactlyOnceWith(
      'io.stagewise/usage-test',
      {
        inputTokens: 10,
        outputTokens: 5,
        inputCacheWriteTokens: 0,
        inputCacheReadTokens: 0,
      },
    );
  });

  it('does not invoke onExtensionUsage when generateText fails', async () => {
    const onExtensionUsage = vi.fn();
    const failingGenText = vi.fn((_args: GenerateTextArgs) =>
      Promise.resolve({
        success: false as const,
        failureReason: 'all-models-failed' as const,
      } satisfies GenerateTextResult),
    );
    const deps: BaseExtensionDeps = {
      ...noopDeps,
      generateText:
        failingGenText as unknown as BaseExtensionDeps['generateText'],
    };

    let receivedDeps: ExtensionDeps | null = null;
    const factory: ExtensionFactory = {
      identifier: 'io.stagewise/usage-fail',
      create: (d) => {
        receivedDeps = d;
        return {};
      },
    };

    createExtensionHandler({
      factories: [factory],
      extensionDeps: deps,
      dataDirectory: '/tmp/test',
      sessionId: 's1',
      onExtensionUsage,
    });

    await receivedDeps!.generateText({ modelIds: ['test:m'], prompt: 'hi' });

    expect(onExtensionUsage).not.toHaveBeenCalled();
  });
});

// --- start / close / getTools lifecycle ---

describe('ExtensionHandler — start()', () => {
  it('calls onStart in factory order', async () => {
    const calls: string[] = [];
    const f1 = factoryWith({
      onStart: async () => {
        calls.push('f1');
      },
    });
    const f2 = factoryWith({
      onStart: async () => {
        calls.push('f2');
      },
    });

    const handler = createExtensionHandler({
      ...HANDLER_OPTS,
      factories: [f1, f2],
    });

    await handler.start();

    expect(calls).toEqual(['f1', 'f2']);
  });

  it('skips extensions without onStart', async () => {
    const calls: string[] = [];
    const f1 = factoryWith({
      onStart: async () => {
        calls.push('f1');
      },
    });
    const f2 = factoryWith({});

    const handler = createExtensionHandler({
      ...HANDLER_OPTS,
      factories: [f1, f2],
    });

    await handler.start();

    expect(calls).toEqual(['f1']);
  });

  it('does nothing when no extensions define onStart', async () => {
    const handler = createExtensionHandler({
      ...HANDLER_OPTS,
      factories: [factoryWith({}), factoryWith({})],
    });

    await expect(handler.start()).resolves.toBeUndefined();
  });

  it('propagates the first error and stops calling subsequent extensions', async () => {
    const calls: string[] = [];
    const f1 = factoryWith({
      onStart: async () => {
        calls.push('f1');
        throw new Error('boom');
      },
    });
    const f2 = factoryWith({
      onStart: async () => {
        calls.push('f2');
      },
    });

    const handler = createExtensionHandler({
      ...HANDLER_OPTS,
      factories: [f1, f2],
    });

    await expect(handler.start()).rejects.toThrow('boom');
    expect(calls).toEqual(['f1']);
  });
});

describe('ExtensionHandler — close()', () => {
  it('calls onClose in reverse factory order (LIFO)', async () => {
    const calls: string[] = [];
    const f1 = factoryWith({
      onClose: async () => {
        calls.push('f1');
      },
    });
    const f2 = factoryWith({
      onClose: async () => {
        calls.push('f2');
      },
    });

    const handler = createExtensionHandler({
      ...HANDLER_OPTS,
      factories: [f1, f2],
    });

    await handler.close();

    expect(calls).toEqual(['f2', 'f1']);
  });

  it('skips extensions without onClose', async () => {
    const calls: string[] = [];
    const f1 = factoryWith({});
    const f2 = factoryWith({
      onClose: async () => {
        calls.push('f2');
      },
    });

    const handler = createExtensionHandler({
      ...HANDLER_OPTS,
      factories: [f1, f2],
    });

    await handler.close();

    expect(calls).toEqual(['f2']);
  });

  it('logs errors from individual extensions but continues closing others', async () => {
    const calls: string[] = [];
    const f1 = factoryWith({
      onClose: async () => {
        calls.push('f1');
      },
    });
    const f2 = factoryWith({
      onClose: async () => {
        calls.push('f2');
        throw new Error('close-boom');
      },
    });

    const handler = createExtensionHandler({
      ...HANDLER_OPTS,
      factories: [f1, f2],
    });

    await handler.close();

    expect(calls).toEqual(['f2', 'f1']);
    expect(noopDeps.logger.error).toHaveBeenCalled();
  });

  it('does nothing when no extensions define onClose', async () => {
    const handler = createExtensionHandler({
      ...HANDLER_OPTS,
      factories: [factoryWith({}), factoryWith({})],
    });

    await expect(handler.close()).resolves.toBeUndefined();
  });
});

describe('ExtensionHandler — getTools()', () => {
  const dummyTool = tool({
    description: 'dummy',
    inputSchema: z.object({}),
    execute: async () => 'ok' as const,
  });

  it('merges tools from all extensions that define getTools', () => {
    const t1 = tool({
      description: 't1',
      inputSchema: z.object({}),
      execute: async () => '1' as const,
    });
    const t2 = tool({
      description: 't2',
      inputSchema: z.object({}),
      execute: async () => '2' as const,
    });

    const handler = createExtensionHandler({
      ...HANDLER_OPTS,
      factories: [
        factoryWith({ getTools: () => ({ tool1: t1 }) }),
        factoryWith({ getTools: () => ({ tool2: t2 }) }),
      ],
    });

    const tools = handler.getTools();

    expect(Object.keys(tools).sort()).toEqual(['tool1', 'tool2']);
  });

  it('skips extensions without getTools', () => {
    const handler = createExtensionHandler({
      ...HANDLER_OPTS,
      factories: [
        factoryWith({}),
        factoryWith({ getTools: () => ({ dummy: dummyTool }) }),
      ],
    });

    const tools = handler.getTools();

    expect(Object.keys(tools)).toEqual(['dummy']);
  });

  it('returns empty object when no extensions define getTools', () => {
    const handler = createExtensionHandler({
      ...HANDLER_OPTS,
      factories: [factoryWith({}), factoryWith({})],
    });

    expect(handler.getTools()).toEqual({});
  });

  it('throws on duplicate tool names', () => {
    const handler = createExtensionHandler({
      ...HANDLER_OPTS,
      factories: [
        factoryWith({ getTools: () => ({ dup: dummyTool }) }),
        factoryWith({ getTools: () => ({ dup: dummyTool }) }),
      ],
    });

    expect(() => handler.getTools()).toThrow('Duplicate tool name "dup"');
  });
});
