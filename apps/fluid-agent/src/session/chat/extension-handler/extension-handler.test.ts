import type { ModelMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';

import type { ExtendedUIMessage } from '@/session/types';

import type {
  DataPartTransformers,
  Extension,
  ExtensionDeps,
  ExtensionFactory,
} from '../extensions/extension-api';
import { createExtensionHandler } from './extension-handler';

// --- fixtures ---

const noopDeps: ExtensionDeps = {
  getHistory: () => [],
  inbox: {
    send: vi.fn(),
    sendMessage: vi.fn(),
    close: vi.fn(),
  },
};

function makeMessage(text: string): ExtendedUIMessage {
  return {
    id: `msg-${text}`,
    role: 'user',
    parts: [{ type: 'text', text }],
  } as ExtendedUIMessage;
}

/** Creates a factory that returns a partial extension with spied hooks. */
function factoryWith(
  overrides: Partial<Extension> & { _spy?: boolean } = {},
): ExtensionFactory {
  return () => ({
    onHistoryPreProcessing: overrides.onHistoryPreProcessing,
    onHistoryPostProcessing: overrides.onHistoryPostProcessing,
    dataPartTransformers: overrides.dataPartTransformers,
  });
}

// --- tests ---

describe('ExtensionHandler — factory', () => {
  it('returns an object implementing ExtensionHandler', () => {
    const handler = createExtensionHandler({
      factories: [],
      extensionDeps: noopDeps,
    });
    expect(typeof handler.onHistoryPreProcessing).toBe('function');
    expect(typeof handler.onHistoryPostProcessing).toBe('function');
    expect(typeof handler.getDataPartTransformers).toBe('function');
  });

  it('instantiates all extensions from the provided factories', () => {
    const factory1 = vi.fn(factoryWith({}));
    const factory2 = vi.fn(factoryWith({}));

    createExtensionHandler({
      factories: [factory1, factory2],
      extensionDeps: noopDeps,
    });

    expect(factory1).toHaveBeenCalledExactlyOnceWith(noopDeps);
    expect(factory2).toHaveBeenCalledExactlyOnceWith(noopDeps);
  });

  it('exposes the instantiated extensions as a readonly array', () => {
    const handler = createExtensionHandler({
      factories: [factoryWith({}), factoryWith({})],
      extensionDeps: noopDeps,
    });
    expect(handler.extensions).toHaveLength(2);
  });

  it('works with zero factories', () => {
    const handler = createExtensionHandler({
      factories: [],
      extensionDeps: noopDeps,
    });
    expect(handler.extensions).toHaveLength(0);
  });
});

describe('ExtensionHandler — onHistoryPreProcessing', () => {
  it('returns the history unchanged with empty flags when no extensions define the hook', async () => {
    const handler = createExtensionHandler({
      factories: [factoryWith({})],
      extensionDeps: noopDeps,
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
      extensionDeps: noopDeps,
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
      extensionDeps: noopDeps,
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
      extensionDeps: noopDeps,
    });

    const result = await handler.onHistoryPreProcessing([makeMessage('orig')]);
    expect(result.history).toEqual([makeMessage('orig'), makeMessage('async')]);
  });

  it('normalizes shorthand return (array only) into { history, flags }', async () => {
    const hook = vi.fn((h: ExtendedUIMessage[]) => h);
    const handler = createExtensionHandler({
      factories: [factoryWith({ onHistoryPreProcessing: hook })],
      extensionDeps: noopDeps,
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
      extensionDeps: noopDeps,
    });

    const result = await handler.onHistoryPreProcessing([makeMessage('a')]);
    expect(result.flags.hasCompacted).toBe(true);
  });
});

describe('ExtensionHandler — onHistoryPostProcessing', () => {
  it('returns the history unchanged with empty flags when no extensions define the hook', async () => {
    const handler = createExtensionHandler({
      factories: [factoryWith({})],
      extensionDeps: noopDeps,
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
      extensionDeps: noopDeps,
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
      extensionDeps: noopDeps,
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
      extensionDeps: noopDeps,
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
      'history-summary': transformer2,
    } as unknown as DataPartTransformers;

    const handler = createExtensionHandler({
      factories: [
        factoryWith({ dataPartTransformers: transformers1 }),
        factoryWith({ dataPartTransformers: transformers2 }),
      ],
      extensionDeps: noopDeps,
    });

    const merged = handler.getDataPartTransformers();
    expect(merged.context).toBe(transformer1);
    expect(merged['history-summary']).toBe(transformer2);
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
      extensionDeps: noopDeps,
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
      extensionDeps: noopDeps,
    });

    const first = handler.getDataPartTransformers();
    const second = handler.getDataPartTransformers();
    expect(first).toEqual(second);
  });
});
