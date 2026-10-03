import { describe, expect, it } from 'vitest';

import type { ProviderInfo } from '../api-client';
import {
  availableInstinctApis,
  containsModelReference,
  matchesModelSearch,
} from './model-selection';

describe('model selection references', () => {
  it('distinguishes instinct APIs without changing ordinary identity and filters native factories', () => {
    const generation = {
      providerId: 'provider',
      modelId: 'native:latest',
      api: 'generation' as const,
      providerOptions: { openai: { mode: 'fast' } },
    };
    const evaluation = { ...generation, api: 'evaluation' as const };
    expect(containsModelReference([generation], evaluation, true)).toBe(false);
    expect(
      containsModelReference(
        [generation, evaluation],
        { ...evaluation, providerOptions: {} },
        true,
      ),
    ).toBe(true);
    expect(containsModelReference([generation], evaluation)).toBe(true);
    const provider = {
      metadata: { capabilities: { generation: false, evaluation: true } },
    } as ProviderInfo;
    expect(
      availableInstinctApis(provider, {
        modelId: 'native',
        kind: 'evaluation',
        source: 'discovered',
      }),
    ).toEqual(['evaluation']);
    expect(
      availableInstinctApis(provider, {
        modelId: 'embed',
        kind: 'embedding',
        source: 'discovered',
      }),
    ).toEqual([]);
    provider.metadata.capabilities.generation = true;
    expect(availableInstinctApis(provider)).toEqual([
      'generation',
      'evaluation',
    ]);
    expect(
      availableInstinctApis(provider, {
        modelId: 'native',
        kind: 'evaluation',
        source: 'discovered',
      }),
    ).toEqual(['evaluation']);
  });

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
