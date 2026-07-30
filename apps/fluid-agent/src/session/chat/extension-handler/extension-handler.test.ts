import type { ModelMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';

import type {
  BaseExtensionDeps,
  DataPartTransformers,
  Extension,
  ExtensionDeps,
  ExtensionFactory,
  StepCompleteEvent,
} from '../extensions/extension-api';
import type { ExtendedUIMessage } from '../message-types';
import { createExtensionHandler } from './extension-handler';

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
  generateTextWithFallback: vi.fn(() => Promise.resolve(null)),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  } as unknown as BaseExtensionDeps['logger'],
};

const HANDLER_OPTS = {
  extensionDeps: noopDeps,
  dataDirectory: '/tmp/test-agent-data',
  sessionId: 'session-123',
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
      identifier: id,
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
      create: () => ({ identifier: 'io.stagewise/duplicate' }),
    };
    expect(() =>
      createExtensionHandler({
        factories: [dup, dup],
        ...HANDLER_OPTS,
      }),
    ).toThrow(/Duplicate extension identifier/);
  });

  it('throws when extension identifier does not match factory identifier', () => {
    const mismatched: ExtensionFactory = {
      identifier: 'io.stagewise/factory-id',
      create: () => ({ identifier: 'io.stagewise/wrong-id' }),
    };
    expect(() =>
      createExtensionHandler({
        factories: [mismatched],
        ...HANDLER_OPTS,
      }),
    ).toThrow(/Extension identifier mismatch/);
  });

  it('provides session-scoped getDataDir by default', () => {
    let receivedDeps: ExtensionDeps | null = null;
    const factory: ExtensionFactory = {
      identifier: 'io.stagewise/getdatadir-test',
      create: (deps) => {
        receivedDeps = deps;
        return { identifier: 'io.stagewise/getdatadir-test' };
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
        return { identifier: 'io.stagewise/getdatadir-global' };
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
    const result = await handler.runHistoryTransformers(history);
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

    const result = await handler.runHistoryTransformers([makeMessage('orig')]);

    expect(hook1).toHaveBeenCalledExactlyOnceWith([makeMessage('orig')]);
    expect(hook2).toHaveBeenCalledExactlyOnceWith([
      makeMessage('orig'),
      makeMessage('ext1'),
    ]);
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

    await handler.runHistoryTransformers([makeMessage('orig')]);

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

    const result = await handler.runHistoryTransformers([makeMessage('orig')]);
    expect(result.history).toEqual([makeMessage('orig'), makeMessage('async')]);
  });

  it('normalizes shorthand return (array only) into { history, flags }', async () => {
    const hook = vi.fn((h: ExtendedUIMessage[]) => h);
    const handler = createExtensionHandler({
      factories: [factoryWith({ historyTransformer: hook })],
      ...HANDLER_OPTS,
    });
    const history = [makeMessage('a')];
    const result = await handler.runHistoryTransformers(history);
    expect(result.history).toBe(history);
    expect(result.flags).toEqual({});
  });

  it('catches and logs errors from a failing transformer without breaking the pipeline', async () => {
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

    const result = await handler.runHistoryTransformers([makeMessage('orig')]);

    expect(hook1).toHaveBeenCalledOnce();
    expect(hook2).toHaveBeenCalledOnce();
    expect(hook3).toHaveBeenCalledOnce();
    // hook2 failed, so hook3 receives the output of hook1 (unchanged).
    expect(hook3).toHaveBeenCalledExactlyOnceWith([
      makeMessage('orig'),
      makeMessage('ext1'),
    ]);
    expect(result.history).toEqual([
      makeMessage('orig'),
      makeMessage('ext1'),
      makeMessage('ext3'),
    ]);
    expect(noopDeps.logger.error).toHaveBeenCalled();
    // The caller must cancel the step because context integrity is uncertain.
    expect(result.flags.hasTransformerError).toBe(true);
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

    const result = await handler.runHistoryTransformers([makeMessage('a')]);
    expect(result.flags.hasCompacted).toBe(true);
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
    const result = await handler.runContextTransformers(history);
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

    const result = await handler.runContextTransformers([
      { role: 'user', content: [{ type: 'text', text: 'orig' }] },
    ] as ModelMessage[]);

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

    await handler.runContextTransformers([
      { role: 'user', content: [{ type: 'text', text: 'a' }] },
    ] as ModelMessage[]);

    expect(hook1).toHaveBeenCalledOnce();
  });

  it('catches and logs errors from a failing transformer without breaking the pipeline', async () => {
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

    const result = await handler.runContextTransformers([
      { role: 'user', content: [{ type: 'text', text: 'orig' }] },
    ] as ModelMessage[]);

    expect(hook1).toHaveBeenCalledOnce();
    expect(hook2).toHaveBeenCalledOnce();
    expect(hook3).toHaveBeenCalledOnce();
    // hook2 failed, so hook3 receives the output of hook1 (unchanged).
    expect(result.history).toHaveLength(3);
    expect(result.history[2]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'ext3' }],
    });
    expect(noopDeps.logger.error).toHaveBeenCalled();
    // The caller must cancel the step because context integrity is uncertain.
    expect(result.flags.hasTransformerError).toBe(true);
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
  };

  it('returns { stop: false, stopReason: null } when no extensions define the hook', async () => {
    const handler = createExtensionHandler({
      factories: [factoryWith({})],
      ...HANDLER_OPTS,
    });
    await expect(handler.runStepCompleteHooks(stepEvent)).resolves.toEqual({
      stop: false,
      stopReason: null,
    });
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

  it('returns stop: true when an extension returns { stop: true }', async () => {
    const hook1 = vi.fn(() => ({ stop: true, stopReason: 'done' }));
    const hook2 = vi.fn(() => {});

    const handler = createExtensionHandler({
      factories: [
        factoryWith({ onStepComplete: hook1 }),
        factoryWith({ onStepComplete: hook2 }),
      ],
      ...HANDLER_OPTS,
    });

    const result = await handler.runStepCompleteHooks(stepEvent);
    expect(result.stop).toBe(true);
    expect(result.stopReason).toBe('done');
  });

  it('returns stop: true when any one extension in a batch requests it', async () => {
    const hook1 = vi.fn(() => {});
    const hook2 = vi.fn(() => ({ stop: true, stopReason: 'limit reached' }));

    const handler = createExtensionHandler({
      factories: [
        factoryWith({ onStepComplete: hook1 }),
        factoryWith({ onStepComplete: hook2 }),
      ],
      ...HANDLER_OPTS,
    });

    const result = await handler.runStepCompleteHooks(stepEvent);
    expect(result.stop).toBe(true);
    expect(result.stopReason).toBe('limit reached');
  });

  it('returns stop: false when no extension requests a stop', async () => {
    const hook1 = vi.fn(() => {});
    const hook2 = vi.fn(() => ({}));

    const handler = createExtensionHandler({
      factories: [
        factoryWith({ onStepComplete: hook1 }),
        factoryWith({ onStepComplete: hook2 }),
      ],
      ...HANDLER_OPTS,
    });

    const result = await handler.runStepCompleteHooks(stepEvent);
    expect(result.stop).toBe(false);
    expect(result.stopReason).toBeNull();
  });
});
