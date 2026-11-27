import { describe, expect, it, vi } from 'vitest';

import { catalog, compile } from './catalog';
import { generatePlan } from './generator';
import systemPrompt from './system-prompt.md';

describe('helper contract', () => {
  const modelIds = [{ providerId: 'test', modelId: 'chat' }];
  const input = catalog({ message: 'hello', tracking: 'opaque' });
  const valid = {
    success: true,
    text: '',
    modelId: 'chat',
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      inputTokenDetails: {
        noCacheTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      outputTokenDetails: { textTokens: 1, reasoningTokens: 0 },
    },
    output: {
      keep: [['message']],
    },
    finishReason: 'stop',
  } as const;
  it('uses structured tool-free output and corrects invalid selections once', async () => {
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
  it('uses the dedicated system prompt for initial generation and feedback review', async () => {
    const generate = vi.fn().mockResolvedValue(valid);
    const identity = catalog({ sourceId: 'chat:42', type: 'message' }).fields;
    await generatePlan(input, { generate, modelIds, identity });
    await generatePlan(
      input,
      { generate, modelIds },
      {
        current: compile(input, valid.output),
        reasons: ['Need the tracking field to investigate delivery'],
      },
    );
    expect(generate).toHaveBeenCalledTimes(2);
    for (const [args] of generate.mock.calls) {
      expect(args.system).toBe(systemPrompt);
    }
    expect(JSON.parse(generate.mock.calls[0]?.[0].prompt)).toEqual({
      fields: input.fields,
      identity,
    });
    expect(() => compile(input, { keep: [['sourceId']] })).toThrow();
    expect(JSON.parse(generate.mock.calls[1]?.[0].prompt).review).toMatchObject(
      {
        reasons: ['Need the tracking field to investigate delivery'],
        current: { keep: [['message']] },
      },
    );
  });
  it('rejects truncation, provider failure and absent models', async () => {
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
  it('allows slow helper responses beyond the former eight-second deadline', async () => {
    vi.useFakeTimers();
    try {
      const generate = vi.fn(
        () =>
          new Promise<typeof valid>((resolve) =>
            setTimeout(() => resolve(valid), 30_000),
          ),
      );
      const pending = generatePlan(input, { generate, modelIds });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await pending).toEqual(compile(input, valid.output));
    } finally {
      vi.useRealTimers();
    }
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
