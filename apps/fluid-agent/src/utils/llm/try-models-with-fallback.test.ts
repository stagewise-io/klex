import { describe, expect, it, vi } from 'vitest';

import type { ModuleLogger } from '@stagewise/logger';

import type { ModelId } from '@/config';
import type { ModelProvider } from '@/model-provider';

import { tryModelsWithFallback } from './try-models-with-fallback';

const MODEL_IDS: readonly ModelId[] = [
  'provider:primary',
  'provider:fallback-a',
  'provider:fallback-b',
];

function makeModelProvider(models: Map<string, unknown>): ModelProvider {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    get: vi.fn(async (id: ModelId): Promise<any> => {
      const m = models.get(id);
      if (!m) throw new Error(`Unknown model: ${id}`);
      return m;
    }),
  };
}

function makeLogger(): ModuleLogger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  };
}

describe('tryModelsWithFallback', () => {
  it('returns the result of the first successful model', async () => {
    const models = new Map([
      ['provider:primary', { id: 'primary' }],
      ['provider:fallback-a', { id: 'fallback-a' }],
    ]);
    const provider = makeModelProvider(models);

    const result = await tryModelsWithFallback(
      MODEL_IDS,
      provider,
      async (model) => (model as any).id,
      { logger: makeLogger(), label: 'test' },
    );

    expect(result).toBe('primary');
  });

  it('falls back to the next model when the first throws', async () => {
    const models = new Map([
      ['provider:primary', { id: 'primary' }],
      ['provider:fallback-a', { id: 'fallback-a' }],
    ]);
    const provider = makeModelProvider(models);

    let callCount = 0;
    const result = await tryModelsWithFallback(
      MODEL_IDS,
      provider,
      async (model) => {
        callCount++;
        if (callCount === 1) throw new Error('primary down');
        return (model as any).id;
      },
      { logger: makeLogger(), label: 'test' },
    );

    expect(result).toBe('fallback-a');
    expect(callCount).toBe(2);
  });

  it('tries all models in order and returns the last one if earlier ones fail', async () => {
    const models = new Map([
      ['provider:primary', { id: 'primary' }],
      ['provider:fallback-a', { id: 'fallback-a' }],
      ['provider:fallback-b', { id: 'fallback-b' }],
    ]);
    const provider = makeModelProvider(models);

    let callCount = 0;
    const result = await tryModelsWithFallback(
      MODEL_IDS,
      provider,
      async (model) => {
        callCount++;
        if (callCount < 3) throw new Error(`model ${callCount} down`);
        return (model as any).id;
      },
      { logger: makeLogger(), label: 'test' },
    );

    expect(result).toBe('fallback-b');
    expect(callCount).toBe(3);
  });

  it('returns null when all models fail', async () => {
    const provider = makeModelProvider(
      new Map([
        ['provider:primary', { id: 'primary' }],
        ['provider:fallback-a', { id: 'fallback-a' }],
      ]),
    );

    const result = await tryModelsWithFallback(
      MODEL_IDS,
      provider,
      async () => {
        throw new Error('always fails');
      },
      { logger: makeLogger(), label: 'test' },
    );

    expect(result).toBeNull();
  });

  it('returns null when the model list is empty', async () => {
    const provider = makeModelProvider(new Map());

    const result = await tryModelsWithFallback(
      [],
      provider,
      async () => 'should-not-be-called',
      { logger: makeLogger(), label: 'test' },
    );

    expect(result).toBeNull();
  });

  it('logs a warning for each failed model', async () => {
    const logger = makeLogger();
    const provider = makeModelProvider(
      new Map([
        ['provider:primary', { id: 'primary' }],
        ['provider:fallback-a', { id: 'fallback-a' }],
        ['provider:fallback-b', { id: 'fallback-b' }],
      ]),
    );

    await tryModelsWithFallback(
      MODEL_IDS,
      provider,
      async () => {
        throw new Error('fail');
      },
      { logger, label: 'compression' },
    );

    expect(logger.warn).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'provider:primary' }),
      'compression model failed — trying next',
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'provider:fallback-a' }),
      'compression model failed — trying next',
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'provider:fallback-b' }),
      'compression model failed — trying next',
    );
  });

  it('logs an error when all models fail', async () => {
    const logger = makeLogger();
    const provider = makeModelProvider(
      new Map([['provider:primary', { id: 'primary' }]]),
    );

    await tryModelsWithFallback(
      ['provider:primary'],
      provider,
      async () => {
        throw new Error('fail');
      },
      { logger, label: 'compression' },
    );

    expect(logger.error).toHaveBeenCalledWith(
      'All models failed for compression',
    );
  });

  it('does not call fn for remaining models after a success', async () => {
    const models = new Map([
      ['provider:primary', { id: 'primary' }],
      ['provider:fallback-a', { id: 'fallback-a' }],
    ]);
    const provider = makeModelProvider(models);

    const fn = vi.fn(async (model: any) => model.id);

    await tryModelsWithFallback(MODEL_IDS, provider, fn, {
      logger: makeLogger(),
      label: 'test',
    });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(provider.get).toHaveBeenCalledTimes(1);
  });

  it('includes the error in the warning log', async () => {
    const logger = makeLogger();
    const provider = makeModelProvider(
      new Map([['provider:primary', { id: 'primary' }]]),
    );
    const testError = new Error('rate limited');

    await tryModelsWithFallback(
      ['provider:primary'],
      provider,
      async () => {
        throw testError;
      },
      { logger, label: 'test' },
    );

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        error: testError,
        modelId: 'provider:primary',
      }),
      'test model failed — trying next',
    );
  });
});
