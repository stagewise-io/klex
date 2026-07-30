import type { ModelMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';

import type { ExtendedUIMessage } from '@/session/types';

import type {
  BaseExtensionDeps,
  DataPartTransformers,
  Extension,
  ExtensionDeps,
  ExtensionFactory,
} from '../extensions/extension-api';
import type { GenerationRunnerResult } from '../step/generation-runner';
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
      onHistoryPreProcessing: overrides.onHistoryPreProcessing,
      onHistoryPostProcessing: overrides.onHistoryPostProcessing,
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
    expect(typeof handler.onHistoryPreProcessing).toBe('function');
    expect(typeof handler.onHistoryPostProcessing).toBe('function');
    expect(typeof handler.getDataPartTransformers).toBe('function');
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

describe('ExtensionHandler — onHistoryPreProcessing', () => {
  it('returns the history unchanged with empty flags when no extensions define the hook', async () => {
    const handler = createExtensionHandler({
      factories: [factoryWith({})],
      ...HANDLER_OPTS,
    });
    const history = [makeMessage('a')];
    const result = await handler.onHistoryPreProcessing(history);
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
        factoryWith({ onHistoryPreProcessing: hook1 }),
        factoryWith({ onHistoryPreProcessing: hook2 }),
      ],
      ...HANDLER_OPTS,
    });

    const result = await handler.onHistoryPreProcessing([makeMessage('orig')]);

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
        factoryWith({ onHistoryPreProcessing: hook1 }),
        factoryWith({}), // no hook
        factoryWith({ onHistoryPreProcessing: hook3 }),
      ],
      ...HANDLER_OPTS,
    });

    await handler.onHistoryPreProcessing([makeMessage('orig')]);

    expect(hook1).toHaveBeenCalledOnce();
    expect(hook3).toHaveBeenCalledOnce();
  });

  it('supports async hooks', async () => {
    const hook = vi.fn(async (h: ExtendedUIMessage[]) => [
      ...h,
      makeMessage('async'),
    ]);

    const handler = createExtensionHandler({
      factories: [factoryWith({ onHistoryPreProcessing: hook })],
      ...HANDLER_OPTS,
    });

    const result = await handler.onHistoryPreProcessing([makeMessage('orig')]);
    expect(result.history).toEqual([makeMessage('orig'), makeMessage('async')]);
  });

  it('normalizes shorthand return (array only) into { history, flags }', async () => {
    const hook = vi.fn((h: ExtendedUIMessage[]) => h);
    const handler = createExtensionHandler({
      factories: [factoryWith({ onHistoryPreProcessing: hook })],
      ...HANDLER_OPTS,
    });
    const history = [makeMessage('a')];
    const result = await handler.onHistoryPreProcessing(history);
    expect(result.history).toBe(history);
    expect(result.flags).toEqual({});
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
        factoryWith({ onHistoryPreProcessing: hook1 }),
        factoryWith({ onHistoryPreProcessing: hook2 }),
      ],
      ...HANDLER_OPTS,
    });

    const result = await handler.onHistoryPreProcessing([makeMessage('a')]);
    expect(result.flags.hasCompacted).toBe(true);
  });
});

describe('ExtensionHandler — onHistoryPostProcessing', () => {
  it('returns the history unchanged with empty flags when no extensions define the hook', async () => {
    const handler = createExtensionHandler({
      factories: [factoryWith({})],
      ...HANDLER_OPTS,
    });
    const history: ModelMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'a' }] },
    ];
    const result = await handler.onHistoryPostProcessing(history);
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
        factoryWith({ onHistoryPostProcessing: hook1 }),
        factoryWith({ onHistoryPostProcessing: hook2 }),
      ],
      ...HANDLER_OPTS,
    });

    const result = await handler.onHistoryPostProcessing([
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
        factoryWith({ onHistoryPostProcessing: hook1 }),
        factoryWith({}), // no hook
      ],
      ...HANDLER_OPTS,
    });

    await handler.onHistoryPostProcessing([
      { role: 'user', content: [{ type: 'text', text: 'a' }] },
    ] as ModelMessage[]);

    expect(hook1).toHaveBeenCalledOnce();
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

describe('ExtensionHandler — onStepComplete', () => {
  const stepResult: GenerationRunnerResult = {
    shouldContinue: true,
    forceNextStep: false,
    fatalError: false,
    fatalErrorReason: null,
    generationFailed: false,
    usage: {
      inputTokens: 100,
      outputTokens: 50,
    },
  };

  it('is a no-op when no extensions define the hook', async () => {
    const handler = createExtensionHandler({
      factories: [factoryWith({})],
      ...HANDLER_OPTS,
    });
    await expect(handler.onStepComplete(stepResult)).resolves.toBeUndefined();
  });

  it('calls onStepComplete on each extension in order', async () => {
    const hook1 = vi.fn(() => {});
    const hook2 = vi.fn(() => {});

    const handler = createExtensionHandler({
      factories: [
        factoryWith({ onStepComplete: hook1 }),
        factoryWith({ onStepComplete: hook2 }),
      ],
      ...HANDLER_OPTS,
    });

    await handler.onStepComplete(stepResult);

    // Each hook receives a shallow copy with the same values.
    expect(hook1).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining(stepResult),
    );
    expect(hook2).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining(stepResult),
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

    await handler.onStepComplete(stepResult);

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

    await handler.onStepComplete(stepResult);
    expect(hook).toHaveBeenCalledOnce();
  });

  it('passes a shallow copy so extensions cannot mutate the original result', async () => {
    const hook1 = vi.fn((result: GenerationRunnerResult) => {
      // Mutate the result — this should NOT affect the original.
      result.shouldContinue = false;
      result.usage = { inputTokens: 999, outputTokens: 999 };
    });
    const hook2 = vi.fn((result: GenerationRunnerResult) => {
      // Should see the original, unmutated values.
      expect(result.shouldContinue).toBe(true);
      expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
    });

    const handler = createExtensionHandler({
      factories: [
        factoryWith({ onStepComplete: hook1 }),
        factoryWith({ onStepComplete: hook2 }),
      ],
      ...HANDLER_OPTS,
    });

    await handler.onStepComplete(stepResult);

    // The original object passed to the handler is unmutated.
    expect(stepResult.shouldContinue).toBe(true);
    expect(stepResult.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
    expect(hook1).toHaveBeenCalledOnce();
    expect(hook2).toHaveBeenCalledOnce();
  });

  it('catches and logs errors from individual extensions without breaking the chain', async () => {
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

    await handler.onStepComplete(stepResult);

    expect(hook1).toHaveBeenCalledOnce();
    expect(hook2).toHaveBeenCalledOnce();
    expect(noopDeps.logger.error).toHaveBeenCalled();
  });
});
