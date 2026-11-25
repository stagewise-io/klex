import { describe, expect, it, vi } from 'vitest';

import { catalog } from './catalog';
import { generatePlan } from './generator';

describe('helper contract', () => {
  const modelIds = [{ providerId: 'test', modelId: 'chat' }];
  const input = catalog({ message: 'hello', tracking: 'opaque' });
  const valid = {
    success: true,
    output: {
      assignments: [
        { fieldId: 'f0', section: 'default' },
        { fieldId: 'f1', section: 'other' },
      ],
    },
    finishReason: 'stop',
  } as const;
  it('uses structured tool-free output and corrects invalid assignments once', async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce({ ...valid, output: {} })
      .mockResolvedValueOnce(valid);
    const plan = await generatePlan(input, { generate, modelIds });
    expect(plan?.fields).toHaveLength(2);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[0]?.[0].tools).toBeUndefined();
    expect(generate.mock.calls[0]?.[0].modelIds).toEqual(modelIds);
  });
  it('rejects truncation, provider failure and absent chat models', async () => {
    const generate = vi
      .fn()
      .mockResolvedValue({ ...valid, finishReason: 'length' });
    expect(await generatePlan(input, { generate, modelIds })).toBeUndefined();
    expect(generate).toHaveBeenCalledTimes(2);
    generate.mockClear();
    expect(
      await generatePlan(input, { generate, modelIds: [] }),
    ).toBeUndefined();
    expect(generate).not.toHaveBeenCalled();
  });
  it('enforces deadline even when provider ignores abort', async () => {
    const generate = vi.fn(() => new Promise<never>(() => {}));
    const start = Date.now();
    expect(
      await generatePlan(input, { generate, modelIds, deadlineMs: 10 }),
    ).toBeUndefined();
    expect(Date.now() - start).toBeLessThan(1_000);
  });
  it('does not invoke models on pre-cancellation or excessive catalogs', async () => {
    const generate = vi.fn();
    expect(
      await generatePlan(input, {
        generate,
        modelIds,
        signal: AbortSignal.abort(),
      }),
    ).toBeUndefined();
    expect(
      await generatePlan(
        catalog(
          Object.fromEntries(Array.from({ length: 129 }, (_, i) => [i, i])),
        ),
        { generate, modelIds },
      ),
    ).toBeUndefined();
    expect(generate).not.toHaveBeenCalled();
  });
});
