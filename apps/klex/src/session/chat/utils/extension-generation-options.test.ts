import { describe, expect, it } from 'vitest';

import { extensionGenerationOptions } from './extension-generation-options';

const modelIds = [{ providerId: 'test', modelId: 'test' }];

describe('extension generation options', () => {
  it('leaves single-step SDK defaults unchanged', () => {
    expect(extensionGenerationOptions({ modelIds, prompt: 'p' })).toEqual({
      abortSignal: undefined,
    });
  });
  it('forwards cancellation and reserves the last step for a tool-free answer', () => {
    const controller = new AbortController();
    const options = extensionGenerationOptions({
      modelIds,
      messages: [],
      maxSteps: 6,
      abortSignal: controller.signal,
    });
    expect(options.abortSignal).toBe(controller.signal);
    expect(options.stopWhen).toBeTypeOf('function');
    expect(options.prepareStep?.({ stepNumber: 4 })).toEqual({});
    expect(options.prepareStep?.({ stepNumber: 5 })).toEqual({
      toolChoice: 'none',
      activeTools: [],
    });
    controller.abort();
    expect(options.abortSignal?.aborted).toBe(true);
  });
  it('bounds step counts and rejects nonfinite counts', () => {
    const options = extensionGenerationOptions({
      modelIds,
      prompt: 'p',
      maxSteps: 100,
    });
    expect(options.prepareStep?.({ stepNumber: 19 })).toEqual({
      toolChoice: 'none',
      activeTools: [],
    });
    expect(
      extensionGenerationOptions({
        modelIds,
        prompt: 'p',
        maxSteps: 0,
      }).prepareStep?.({ stepNumber: 0 }),
    ).toEqual({ toolChoice: 'none', activeTools: [] });
    expect(() =>
      extensionGenerationOptions({ modelIds, prompt: 'p', maxSteps: NaN }),
    ).toThrow(RangeError);
  });
});
