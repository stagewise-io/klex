import { afterEach, describe, expect, it, vi } from 'vitest';

import { getProviderSettingsJsonSchema, parseProviderSettings } from '@/config';

import type {
  ProviderContext,
  ProviderDefinition,
  ProviderInstance,
} from '../provider-registry';
import {
  klexCloudProtocol,
  klexCloudProviderDefinition as provider,
} from './klex-cloud';

const instance: ProviderInstance = {
  id: 'stagewise-managed-cloud',
  type: 'klex-cloud',
  settings: {
    baseUrl: 'https://gateway.example/v1',
    apiKey: 'sk_sw_synthetic',
  },
};
const withProtocols = (protocols: Record<string, unknown>) => ({
  ...instance,
  settings: { ...instance.settings, protocols },
});
const signal = () => new AbortController().signal;
const prompt = [
  { role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] },
];

function captureRequests() {
  const requests: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response('{}', { status: 400 });
    }),
  );
  return requests;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('Klex Cloud settings', () => {
  it('accepts gateway settings, the protocol map and reserved realtime fields', () => {
    const settings = {
      baseUrl: 'https://gateway.example/v1',
      apiKey: '${env:KLEX_CLOUD_TOKEN}',
      protocols: {
        'openai/gpt-6-luna': 'responses',
        'openai/gpt-audio-mini': 'chat-completions',
        'anthropic/claude-sonnet-5': 'anthropic-messages',
        'openai/gpt-live-1': 'openai-live',
      },
      realtimeBaseUrl: 'wss://gateway.example/v1',
    };
    expect(parseProviderSettings('klex-cloud', settings)).toEqual(settings);
    expect(
      parseProviderSettings('klex-cloud', {
        baseUrl: 'https://gateway.example/v1',
        apiKey: 'sk_sw_synthetic',
      }),
    ).toEqual({
      baseUrl: 'https://gateway.example/v1',
      apiKey: 'sk_sw_synthetic',
    });
  });

  it.each([
    ['missing base URL', { apiKey: 'key' }],
    ['missing API key', { baseUrl: 'https://gateway.example/v1' }],
    ['environment base URL', { baseUrl: '${env:GATEWAY_URL}', apiKey: 'key' }],
    [
      'environment realtime URL',
      {
        baseUrl: 'https://gateway.example/v1',
        apiKey: 'key',
        realtimeBaseUrl: '${env:REALTIME_URL}',
      },
    ],
    [
      'non-HTTP realtime URL',
      {
        baseUrl: 'https://gateway.example/v1',
        apiKey: 'key',
        realtimeBaseUrl: 'ftp://gateway.example/v1',
      },
    ],
    [
      'unknown protocol',
      {
        baseUrl: 'https://gateway.example/v1',
        apiKey: 'key',
        protocols: { model: 'google' },
      },
    ],
    [
      'empty model ID',
      {
        baseUrl: 'https://gateway.example/v1',
        apiKey: 'key',
        protocols: { '': 'responses' },
      },
    ],
    [
      'custom headers',
      {
        baseUrl: 'https://gateway.example/v1',
        apiKey: 'key',
        headers: { 'X-Upstream': 'other' },
      },
    ],
  ])('rejects %s', (_name, settings) => {
    expect(() => parseProviderSettings('klex-cloud', settings)).toThrow();
  });

  it('marks the token secret and the reserved realtime URL read-only', () => {
    expect(getProviderSettingsJsonSchema('klex-cloud')).toMatchObject({
      required: ['baseUrl', 'apiKey'],
      properties: {
        apiKey: { writeOnly: true, format: 'password' },
        realtimeBaseUrl: { readOnly: true },
      },
    });
  });
});

describe('Klex Cloud routing', () => {
  it.each([
    ['openai/gpt-6-luna', 'klex-cloud.responses'],
    ['gpt-6-luna', 'klex-cloud.responses'],
    ['google/gemini-3-pro', 'klex-cloud.responses'],
    ['openai/gpt-live-1', 'klex-cloud.responses'],
    ['openai/gpt-audiobook', 'klex-cloud.responses'],
    ['openai/claude-compatible', 'klex-cloud.responses'],
    ['openai/gpt-audio-mini', 'klex-cloud.chat'],
    ['openai/gpt-audio', 'klex-cloud.responses'],
    ['gpt-audio-mini', 'klex-cloud.chat'],
    ['GPT-AUDIO-2', 'klex-cloud.chat'],
    ['anthropic/claude-sonnet-5', 'klex-cloud.messages'],
    ['Anthropic/custom', 'klex-cloud.messages'],
    ['claude-opus-5', 'klex-cloud.messages'],
  ])('routes %s by name to %s', (modelId, sdk) => {
    const model = provider.createLanguageModel(instance, modelId);
    expect(model.provider).toBe(sdk);
    expect(model.modelId).toBe(modelId);
  });

  it('prefers the protocols setting over name rules', () => {
    const configured = withProtocols({
      'anthropic/claude-sonnet-5': 'responses',
      'openai/gpt-audio-mini': 'responses',
      'vendor/voice-model': 'chat-completions',
      'vendor/messages-model': 'anthropic-messages',
    });
    expect(
      provider.createLanguageModel(configured, 'anthropic/claude-sonnet-5')
        .provider,
    ).toBe('klex-cloud.responses');
    expect(
      provider.createLanguageModel(configured, 'openai/gpt-audio-mini')
        .provider,
    ).toBe('klex-cloud.responses');
    expect(
      provider.createLanguageModel(configured, 'vendor/voice-model').provider,
    ).toBe('klex-cloud.chat');
    expect(
      provider.createLanguageModel(configured, 'vendor/messages-model')
        .provider,
    ).toBe('klex-cloud.messages');
  });

  it('matches protocol entries exactly and ignores invalid values', () => {
    const configured = withProtocols({
      'openai/GPT-6-luna': 'chat-completions',
      'claude-opus-5': 'google',
    });
    expect(klexCloudProtocol(configured, 'openai/gpt-6-luna')).toBe(
      'responses',
    );
    expect(klexCloudProtocol(configured, 'claude-opus-5')).toBe(
      'anthropic-messages',
    );
  });

  it('never routes from discovery', () => {
    const context: ProviderContext = {
      credential: async () => undefined,
      invalidate: async () => undefined,
      discoveredModel: (modelId) => ({ modelId, kind: 'language' }),
    };
    expect(
      (provider as ProviderDefinition).createLanguageModel?.(
        instance,
        'vendor/discovered',
        context,
      ).provider,
    ).toBe('klex-cloud.responses');
  });

  it('refuses the reserved openai-live protocol', () => {
    expect(() =>
      provider.createLanguageModel(
        withProtocols({ 'openai/gpt-live-1': 'openai-live' }),
        'openai/gpt-live-1',
      ),
    ).toThrow(/reserved 'openai-live' protocol/);
  });
});

describe('Klex Cloud requests', () => {
  it.each([
    ['openai/gpt-6-luna', 'https://gateway.example/v1/responses'],
    ['openai/gpt-audio-mini', 'https://gateway.example/v1/chat/completions'],
    ['anthropic/claude-sonnet-5', 'https://gateway.example/v1/messages'],
  ])('sends %s to %s with only the gateway token', async (modelId, url) => {
    vi.stubEnv('OPENAI_API_KEY', 'environment-openai-key');
    vi.stubEnv('ANTHROPIC_API_KEY', 'environment-anthropic-key');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://environment.example/v1');
    const requests = captureRequests();
    const model = provider.createLanguageModel(instance, modelId);
    await expect(model.doGenerate({ prompt })).rejects.toThrow();
    expect(requests).toHaveLength(1);
    const request = requests[0];
    if (!request) throw new Error('Missing request');
    expect(request.url).toBe(url);
    const headers = new Headers(request.init.headers);
    expect(headers.get('authorization')).toBe('Bearer sk_sw_synthetic');
    expect(headers.get('x-api-key')).toBeNull();
    expect(headers.get('x-title')).toBe('Klex');
    expect(JSON.parse(String(request.init.body)).model).toBe(modelId);
  });

  it('reads provider options from the klex-cloud namespace on every protocol', async () => {
    const requests = captureRequests();
    const generate = (modelId: string, options: Record<string, unknown>) =>
      expect(
        provider.createLanguageModel(instance, modelId).doGenerate({
          prompt,
          providerOptions: { 'klex-cloud': options } as never,
        }),
      ).rejects.toThrow();
    await generate('openai/gpt-6-luna', { reasoningEffort: 'high' });
    await generate('openai/gpt-audio-mini', { reasoningEffort: 'low' });
    await generate('anthropic/claude-sonnet-5', {
      thinking: { type: 'enabled', budgetTokens: 2048 },
    });
    const [responses, chat, messages] = requests.map((request) =>
      JSON.parse(String(request.init.body)),
    );
    expect(responses.reasoning).toMatchObject({ effort: 'high' });
    expect(chat.reasoning_effort).toBe('low');
    expect(messages.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
  });

  it('keeps Anthropic prompt caching', async () => {
    const requests = captureRequests();
    await expect(
      provider
        .createLanguageModel(instance, 'anthropic/claude-sonnet-5')
        .doGenerate({ prompt }),
    ).rejects.toThrow();
    expect(JSON.parse(String(requests[0]?.init.body)).cache_control).toEqual({
      type: 'ephemeral',
    });
  });

  it('forwards cache control set in the klex-cloud namespace', async () => {
    const requests = captureRequests();
    await expect(
      provider
        .createLanguageModel(instance, 'anthropic/claude-sonnet-5')
        .doGenerate({
          prompt,
          providerOptions: {
            'klex-cloud': { cacheControl: { type: 'ephemeral', ttl: '1h' } },
          },
        }),
    ).rejects.toThrow();
    expect(JSON.parse(String(requests[0]?.init.body)).cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    });
  });
});

describe('Klex Cloud discovery', () => {
  it('lists gateway models from IDs-only metadata', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init) => {
        calls.push({ url: String(url), init });
        return Response.json({
          object: 'list',
          data: [
            {
              id: 'openai/gpt-6-luna',
              object: 'model',
              created: 1764000000,
              owned_by: 'openai',
            },
            { id: 'anthropic/claude-sonnet-5', object: 'model' },
            { id: 'openai/text-embedding-3-small', object: 'model' },
            { id: 'openai/gpt-live-1', object: 'model' },
            { id: 'openai/gpt-live-1-2026-11-01', object: 'model' },
            { id: 'openai/gpt-live-2', object: 'model' },
            { id: 'openai/gpt-transcribe', object: 'model' },
            { id: 'vendor/uncatalogued', object: 'model' },
            { id: 42 },
            { id: '' },
            'invalid',
          ],
        });
      }),
    );
    const result = await provider.discoverModels(instance, signal());
    expect(result).toEqual({
      ok: true,
      code: 'available',
      value: [
        {
          modelId: 'openai/gpt-6-luna',
          createdAt: new Date(1764000000 * 1000).toISOString(),
        },
        { modelId: 'anthropic/claude-sonnet-5' },
        { modelId: 'vendor/uncatalogued' },
      ],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://gateway.example/v1/models');
    expect(new Headers(calls[0]?.init.headers).get('authorization')).toBe(
      'Bearer sk_sw_synthetic',
    );
  });

  it.each([
    ['an HTTP error', () => new Response('{}', { status: 401 })],
    ['a body without data', () => Response.json({ models: [] })],
  ])('reports %s as unavailable', async (_name, response) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response()),
    );
    expect(await provider.discoverModels(instance, signal())).toMatchObject({
      ok: false,
      code: 'discovery_failed',
    });
    expect(await provider.testConnection(instance, signal())).toMatchObject({
      ok: false,
      code: 'connectivity_failed',
    });
  });

  it('tests connectivity by listing models without inference', async () => {
    const fetch = vi.fn(async () => Response.json({ data: [] }));
    vi.stubGlobal('fetch', fetch);
    expect(await provider.testConnection(instance, signal())).toMatchObject({
      ok: true,
      value: { target: 'https://gateway.example' },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.at(0))).toBe(
      'https://gateway.example/v1/models',
    );
  });

  it.each([
    ['openai/gpt-6-luna', 'language'],
    ['gpt-6-luna', 'language'],
    ['openai/gpt-oss-120b', 'language'],
    ['anthropic/claude-sonnet-5', 'language'],
    ['claude-sonnet-5', 'language'],
    ['openai/gpt-live-1', 'speech-to-speech'],
    ['openai/gpt-live-1-2026-11-01', 'speech-to-speech'],
    ['vendor/unknown-model', undefined],
  ])('resolves catalog metadata for %s', (modelId, kind) => {
    expect(provider.resolveModelMetadata(modelId)?.kind).toBe(kind);
  });

  it('declares audio input for gateway audio models', () => {
    expect(
      provider.resolveModelMetadata('openai/gpt-audio-mini')?.capabilities
        ?.input?.audio,
    ).toBeDefined();
    expect(
      provider.resolveModelMetadata('anthropic/claude-sonnet-5')?.contextSize,
    ).toBeGreaterThan(0);
  });
});
