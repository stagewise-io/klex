import { describe, expect, it } from 'vitest';

import { mergeProviderModels, resolveMetadataRules } from './model-metadata';

describe('model metadata', () => {
  it('deep-merges capabilities without mutating inputs', () => {
    const discovered = {
      modelId: 'model',
      contextSize: 100,
      capabilities: { input: { image: {} }, voice: { tts: false } },
    } as const;
    const manual = {
      modelId: 'model',
      capabilities: { voice: { tts: true } },
    } as const;

    expect(mergeProviderModels(discovered, manual)).toMatchObject({
      modelId: 'model',
      contextSize: 100,
      capabilities: { input: { image: {} }, voice: { tts: true } },
    });
    expect(discovered.capabilities.voice.tts).toBe(false);
  });

  it('applies exact rules after family rules', () => {
    expect(
      resolveMetadataRules('family-exact', [
        {
          match: { exact: 'family-exact' },
          metadata: { contextSize: 200 },
          provenance: { source: 'provider-exact' },
        },
        {
          match: { prefix: 'family-' },
          metadata: { contextSize: 100, kind: 'language' },
          provenance: { source: 'provider-family' },
        },
      ]),
    ).toMatchObject({ contextSize: 200, kind: 'language' });
  });
});
