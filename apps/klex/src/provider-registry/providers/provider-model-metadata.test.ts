import { describe, expect, it } from 'vitest';

import type { ModelKind, ProviderType } from '@/config';

import { builtInProviderDefinitions } from './providers';

const CASES: ReadonlyArray<{
  type: ProviderType;
  modelId: string;
  kind: ModelKind | undefined;
}> = [
  { type: 'openai', modelId: 'gpt-4o', kind: 'language' },
  { type: 'anthropic', modelId: 'claude-sonnet-5', kind: 'language' },
  { type: 'google-gemini', modelId: 'gemini-2.5-pro', kind: 'language' },
  { type: 'google-vertex', modelId: 'gemini-2.5-pro', kind: 'language' },
  { type: 'amazon-bedrock', modelId: 'anthropic.claude-v4', kind: 'language' },
  { type: 'azure-openai', modelId: 'production', kind: undefined },
  { type: 'openrouter', modelId: 'openai/gpt-oss-120b', kind: 'language' },
  { type: 'moonshot', modelId: 'kimi-k3', kind: 'language' },
  { type: 'alibaba-qwen', modelId: 'qwen2.5-vl-72b', kind: 'language' },
  { type: 'deepseek', modelId: 'deepseek-v4-flash', kind: 'language' },
  { type: 'zai', modelId: 'glm-4.5', kind: 'language' },
  { type: 'minimax', modelId: 'MiniMax-M3', kind: 'language' },
  { type: 'xiaomi-mimo', modelId: 'mimo-v2', kind: 'language' },
  { type: 'mistral', modelId: 'mistral-medium-3-5', kind: 'language' },
  { type: 'xai', modelId: 'grok-2-vision', kind: 'language' },
  { type: 'glm-coding-plan', modelId: 'glm-4.5', kind: 'language' },
  { type: 'minimax-coding-plan', modelId: 'MiniMax-M2', kind: 'language' },
  { type: 'opencode-go', modelId: 'routed-model', kind: undefined },
  { type: 'opencode-zen', modelId: 'routed-model', kind: undefined },
  {
    type: 'chatgpt-codex-subscription',
    modelId: 'gpt-5-codex',
    kind: 'language',
  },
  {
    type: 'chat-completions',
    modelId: 'google/gemma-4-e2b',
    kind: 'language',
  },
  { type: 'responses', modelId: 'opaque-deployment', kind: undefined },
  {
    type: 'anthropic-messages',
    modelId: 'claude-haiku-4-5-20251001',
    kind: 'language',
  },
  { type: 'google-generative', modelId: 'gemini-2.5-flash', kind: 'language' },
  { type: 'ollama', modelId: 'gpt-oss-20b:latest', kind: 'language' },
];

describe('built-in provider model catalogs', () => {
  it.each(CASES)(
    '$type resolves $modelId conservatively',
    ({ type, modelId, kind }) => {
      const definition = builtInProviderDefinitions.find(
        (item) => item.type === type,
      );
      expect(definition).toBeDefined();
      expect(definition?.resolveModelMetadata?.(modelId)?.kind).toBe(kind);
    },
  );

  it('covers every built-in provider definition exactly once', () => {
    expect(new Set(CASES.map(({ type }) => type))).toEqual(
      new Set(builtInProviderDefinitions.map(({ type }) => type)),
    );
  });

  it.each([
    ['openai', 'gpt-6.1', { image: {} }],
    ['anthropic', 'claude-sonnet-6-20270101', { image: expect.any(Object) }],
    [
      'google-gemini',
      'gemini-4.1-pro',
      { image: expect.any(Object), audio: expect.any(Object) },
    ],
    ['moonshot', 'kimi-k4', { image: expect.any(Object) }],
    ['alibaba-qwen', 'qwen4-vl-70b', { image: {} }],
    ['zai', 'glm-6v-flash', { image: {} }],
    ['minimax', 'MiniMax-M4', { image: {} }],
    ['xiaomi-mimo', 'mimo-v3-vl', { image: {} }],
    ['mistral', 'mistral-large-4', { image: expect.any(Object) }],
    ['xai', 'grok-5-fast', { image: {} }],
  ] as const)(
    '%s applies provider-owned future-family capabilities to %s',
    (type, modelId, input) => {
      const definition = builtInProviderDefinitions.find(
        (item) => item.type === type,
      );
      expect(definition?.resolveModelMetadata?.(modelId)).toMatchObject({
        kind: 'language',
        capabilities: { input },
        provenance: [expect.objectContaining({ source: 'provider-family' })],
      });
    },
  );

  it('keeps gateway matching conservative while accepting safe ID variants', () => {
    const openrouter = builtInProviderDefinitions.find(
      ({ type }) => type === 'openrouter',
    );
    expect(
      openrouter?.resolveModelMetadata?.('google/gemma-3-4b-it:free'),
    ).toMatchObject({
      kind: 'language',
      contextSize: 131_072,
      capabilities: { input: { image: {} } },
    });
    expect(
      openrouter?.resolveModelMetadata?.('openai/gpt-oss-120b:free'),
    ).toMatchObject({ kind: 'language', contextSize: 131_072 });
    expect(
      openrouter?.resolveModelMetadata?.('vendor/not-gemma-3-4b'),
    ).toBeUndefined();
    expect(
      openrouter?.resolveModelMetadata?.('google/gemma-3-4b-unreviewed'),
    ).toBeUndefined();
  });

  it('does not infer capabilities for opaque deployments and routers', () => {
    for (const type of [
      'azure-openai',
      'chat-completions',
      'responses',
      'opencode-go',
      'opencode-zen',
    ] as const) {
      const definition = builtInProviderDefinitions.find(
        (item) => item.type === type,
      );
      expect(
        definition?.resolveModelMetadata?.('production-gpt-vision'),
      ).toBeUndefined();
    }
  });

  it('preserves researched context and attachment limits', () => {
    const openai = builtInProviderDefinitions.find(
      ({ type }) => type === 'openai',
    );
    expect(openai?.resolveModelMetadata?.('gpt-realtime-2.1')).toMatchObject({
      kind: 'speech-to-speech',
      contextSize: 128_000,
      capabilities: { input: { image: {}, audio: {} }, voice: { sts: true } },
    });
    expect(openai?.resolveModelMetadata?.('gpt-transcribe')).toMatchObject({
      capabilities: {
        input: { audio: { maxBytes: 25_000_000 } },
        voice: { stt: true },
      },
    });

    const anthropic = builtInProviderDefinitions.find(
      ({ type }) => type === 'anthropic',
    );
    expect(anthropic?.resolveModelMetadata?.('claude-sonnet-5')).toMatchObject({
      contextSize: 1_000_000,
      capabilities: {
        input: {
          image: { maxBytes: 10_000_000, maxWidth: 8_000, maxHeight: 8_000 },
        },
      },
    });
  });
});
