import { describe, expect, it } from 'vitest';

import { containsModelReference } from './model-selection';

describe('model selection references', () => {
  it('uses provider instance and opaque native model ID as separate keys', () => {
    const entries = [
      { providerId: 'openai-primary', modelId: 'vendor:model:latest' },
      { providerId: 'openai-secondary', modelId: 'vendor:model:latest' },
    ];

    expect(
      containsModelReference(entries, {
        providerId: 'openai-primary',
        modelId: 'vendor:model:latest',
      }),
    ).toBe(true);
    expect(
      containsModelReference(entries, {
        providerId: 'openai-primary',
        modelId: 'vendor:model:preview',
      }),
    ).toBe(false);
  });
});
