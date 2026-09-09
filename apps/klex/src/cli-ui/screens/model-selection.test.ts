import { describe, expect, it } from 'vitest';

import { containsModelReference, matchesModelSearch } from './model-selection';

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

describe('model search', () => {
  const model = {
    modelId: 'gpt-5.3-codex',
    displayName: 'GPT Codex Pro',
    source: 'discovered' as const,
  };

  it('matches every space-delimited term fuzzily across name and ID', () => {
    expect(matchesModelSearch(model, 'GCP 53')).toBe(true);
    expect(matchesModelSearch(model, 'cod pro')).toBe(true);
    expect(matchesModelSearch(model, 'GCP missing')).toBe(false);
  });
});
