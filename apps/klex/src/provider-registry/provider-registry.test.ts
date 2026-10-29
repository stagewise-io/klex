import type { LanguageModelV4 } from '@ai-sdk/provider';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RootLogger } from '@stagewise/logger';

import { type ProviderType, parseProviderSettings } from '@/config';

import {
  createProviderRegistry,
  type ProviderDefinition,
} from './provider-registry';
import { builtInProviderDefinitions } from './providers/providers';

const logging = {
  child: () => ({ info: () => undefined }),
} as unknown as RootLogger;

const fsMocks = vi.hoisted(() => ({
  access: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  ...fsMocks,
}));

const signal = () => new AbortController().signal;

function builtIn(type: ProviderType): ProviderDefinition {
  const provider = builtInProviderDefinitions.find(
    (item) => item.type === type,
  );
  if (!provider) throw new Error(`Missing built-in provider '${type}'`);
  return provider;
}

function validationError(type: ProviderType, settings: unknown): unknown {
  try {
    parseProviderSettings(type, settings);
  } catch (error) {
    return error;
  }
  throw new Error(`Expected '${type}' settings to be rejected`);
}

function discovery(provider: ProviderDefinition) {
  const discoverModels = provider.discoverModels;
  if (!discoverModels)
    throw new Error(`Provider '${provider.type}' does not support discovery`);
  return discoverModels;
}

beforeEach(() => {
  vi.clearAllMocks();
  fsMocks.access.mockRejectedValue(new Error('ENOENT'));
  fsMocks.readFile.mockRejectedValue(new Error('ENOENT'));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function validSettings(type: ProviderType): Record<string, unknown> {
  if (type === 'ollama') return {};
  if (type === 'chatgpt-codex-subscription') return {};
  if (type === 'google-vertex')
    return { authMode: 'adc', project: 'project', testModelId: 'model' };
  if (type === 'amazon-bedrock')
    return { authMode: 'default-chain', testModelId: 'model' };
  if (type === 'azure-openai')
    return { resourceName: 'resource', apiKey: 'key', testModelId: 'model' };
  if (
    type === 'chat-completions' ||
    type === 'responses' ||
    type === 'anthropic-messages' ||
    type === 'google-generative'
  )
    return {
      baseUrl: 'https://example.test/v1',
      apiKey: 'key',
      testModelId: 'model',
    };
  return { apiKey: 'key' };
}

function definition(
  type: ProviderType,
  displayName: string = type,
): ProviderDefinition {
  return {
    type,
    usageGuidance:
      'Use this test provider for registry contract tests with injected settings; use another provider for production transports.',
    metadata: {
      displayName,
      description: `${displayName} provider`,
    },
    preflightCreate: async () => ({
      ok: true,
      code: 'available',
      value: undefined,
    }),
    createLanguageModel: () => ({}) as LanguageModelV4,
    testConnection: async () => ({
      ok: true,
      code: 'available',
      value: { latencyMs: 1 },
    }),
  };
}

describe('ProviderRegistry', () => {
  it('starts and closes idempotently and sorts metadata', async () => {
    const registry = createProviderRegistry({
      logging,
      definitions: [definition('xai', 'Zulu'), definition('openai', 'Alpha')],
    });

    await registry.start();
    await registry.start();
    expect(registry.listProviderTypes().map((item) => item.type)).toEqual([
      'openai',
      'xai',
    ]);
    await registry.close();
    await registry.close();
  });

  it('registers the complete unique built-in inventory', () => {
    const definitions = builtInProviderDefinitions;
    const types = definitions.map((item) => item.type);
    expect(new Set(types).size).toBe(types.length);
    expect(types).toEqual([
      'openai',
      'anthropic',
      'google-gemini',
      'google-vertex',
      'amazon-bedrock',
      'azure-openai',
      'openrouter',
      'moonshot',
      'alibaba-qwen',
      'deepseek',
      'zai',
      'minimax',
      'xiaomi-mimo',
      'mistral',
      'xai',
      'glm-coding-plan',
      'minimax-coding-plan',
      'opencode-go',
      'opencode-zen',
      'chatgpt-codex-subscription',
      'chat-completions',
      'responses',
      'anthropic-messages',
      'google-generative',
      'ollama',
      'typesafe-ai',
      'vercel-ai-gateway',
    ]);
    for (const item of definitions) {
      expect(item.metadata.displayName).not.toBe('');
      expect(item.metadata.description).not.toBe('');
      expect(item.usageGuidance.length).toBeGreaterThan(40);
    }
    const registry = createProviderRegistry({ logging, definitions });
    expect(
      registry
        .listProviderTypes()
        .find(({ type }) => type === 'chatgpt-codex-subscription')?.capabilities
        .modelDiscovery,
    ).toBe(true);
  });

  it('uses provider-native SDKs for cloud transports', () => {
    const cases = [
      ['azure-openai', { apiKey: 'key', resourceName: 'resource' }],
      [
        'amazon-bedrock',
        { region: 'us-east-1', accessKeyId: 'id', secretAccessKey: 'secret' },
      ],
      ['google-vertex', { project: 'project', location: 'us-central1' }],
    ] as const;

    for (const [type, settings] of cases) {
      const provider = builtIn(type);
      if (!provider.createLanguageModel)
        throw new Error('Missing language factory');
      const model = provider.createLanguageModel(
        { id: 'instance', type, settings },
        'test-model',
      );
      expect(model.specificationVersion).toBe('v4');
    }
  });

  it('discovers the documented OpenAI model-list response shape', async () => {
    // https://platform.openai.com/docs/api-reference/models/list
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        object: 'list',
        data: [
          {
            id: 'gpt-test',
            object: 'model',
            created: 1_688_935_002,
            owned_by: 'openai',
          },
        ],
      }),
    );
    const provider = builtIn('openai');

    vi.stubGlobal('fetch', fetchMock);
    const result = await discovery(provider)(
      { id: 'openai-1', type: 'openai', settings: { apiKey: 'secret' } },
      signal(),
    );

    expect(result.ok && result.value).toEqual([
      { modelId: 'gpt-test', createdAt: '2023-07-09T20:36:42.000Z' },
    ]);
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).pathname).toBe(
      '/v1/models',
    );
    expect(fetchMock.mock.calls[0]?.[1].headers).toMatchObject({
      Authorization: 'Bearer secret',
    });
  });

  it('discovers documented Anthropic metadata and pagination', async () => {
    // https://docs.anthropic.com/en/api/models-list
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          data: [
            {
              id: 'claude-a',
              created_at: '2026-01-02T02:00:00+02:00',
              display_name: 'Claude A',
              max_input_tokens: 200_000,
              capabilities: {
                image_input: { supported: true },
                thinking: { supported: true },
                code_execution: { supported: true },
              },
            },
          ],
          has_more: true,
          last_id: 'claude-a',
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ data: [{ id: 'claude-b' }], has_more: false }),
      );
    const provider = builtIn('anthropic');

    vi.stubGlobal('fetch', fetchMock);
    const result = await discovery(provider)(
      {
        id: 'anthropic-1',
        type: 'anthropic',
        settings: { apiKey: 'secret' },
      },
      signal(),
    );

    expect(result.ok && result.value).toEqual([
      {
        modelId: 'claude-a',
        createdAt: '2026-01-02T00:00:00.000Z',
        displayName: 'Claude A',
        contextSize: 200_000,
        capabilities: { input: { image: {} }, reasoning: true },
      },
      { modelId: 'claude-b' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      new URL(String(fetchMock.mock.calls[1]?.[0])).searchParams.get(
        'after_id',
      ),
    ).toBe('claude-a');
    expect(fetchMock.mock.calls[0]?.[1].headers).toMatchObject({
      'x-api-key': 'secret',
      'anthropic-version': '2023-06-01',
    });
  });

  it('discovers the documented Google Gemini model-list response', async () => {
    // https://ai.google.dev/api/models#method:-models.list
    const google = builtIn('google-gemini');
    const googleFetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          models: [
            {
              name: 'models/gemini-test',
              displayName: 'Gemini Test',
              inputTokenLimit: 32_000,
              outputTokenLimit: 8_192,
              supportedGenerationMethods: ['generateContent'],
            },
            {
              name: 'models/embed-test',
              supportedGenerationMethods: ['embedContent'],
            },
            {
              name: 'models/imagen-test',
              supportedGenerationMethods: ['predict'],
            },
          ],
          nextPageToken: 'next-page',
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          models: [
            {
              name: 'models/gemini-9-flash-preview-tts',
              supportedGenerationMethods: ['generateContent'],
            },
            {
              name: 'models/gemini-9-flash-image',
              supportedGenerationMethods: ['generateContent'],
            },
            {
              name: 'models/gemini-9-flash-live',
              supportedGenerationMethods: ['bidiGenerateContent'],
            },
            {
              name: 'models/gemini-9-pro',
              thinking: true,
              supportedGenerationMethods: ['generateContent', 'countTokens'],
            },
          ],
        }),
      );
    vi.stubGlobal('fetch', googleFetch);
    const googleResult = await discovery(google)(
      { id: 'google-1', type: 'google-gemini', settings: { apiKey: 'key' } },
      signal(),
    );
    // Catalog kinds win for TTS, image and Live models; non-chat models drop.
    expect(googleResult.ok && googleResult.value).toEqual([
      {
        modelId: 'gemini-test',
        displayName: 'Gemini Test',
        contextSize: 32_000,
      },
      { modelId: 'gemini-9-flash-preview-tts' },
      { modelId: 'gemini-9-flash-image' },
      { modelId: 'gemini-9-flash-live' },
      { modelId: 'gemini-9-pro', capabilities: { reasoning: true } },
    ]);
    expect(
      [
        'gemini-9-flash-preview-tts',
        'gemini-9-flash-image',
        'gemini-9-flash-live',
      ].map((modelId) => google.resolveModelMetadata?.(modelId)?.kind),
    ).toEqual(['text-to-speech', 'image-generation', 'speech-to-speech']);
    expect(google.catalogModels).toContainEqual(
      expect.objectContaining({ modelId: 'gemini-2.5-pro', kind: 'language' }),
    );
    expect(
      new URL(String(googleFetch.mock.calls[0]?.[0])).searchParams.get('key'),
    ).toBe('key');
    expect(
      new URL(String(googleFetch.mock.calls[1]?.[0])).searchParams.get(
        'pageToken',
      ),
    ).toBe('next-page');
  });

  it('drops OpenAI models no Klex purpose can use', async () => {
    const ids = [
      'babbage-002',
      'davinci-002',
      'gpt-3.5-turbo-instruct',
      'gpt-3.5-turbo-instruct-0914',
      'text-embedding-3-large',
      'text-moderation-latest',
      'omni-moderation-2024-09-26',
      'sora-2',
      'gpt-5.5',
      'gpt-3.5-turbo',
      'gpt-realtime-2',
      'gpt-4o-transcribe',
      'whisper-1',
      'tts-1-hd',
      'gpt-audio-1.5',
      'gpt-image-2',
      'chatgpt-image-latest',
    ];
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ data: ids.map((id) => ({ id, object: 'model' })) }),
        ),
    );
    const openai = builtIn('openai');
    const result = await discovery(openai)(
      { id: 'openai-1', type: 'openai', settings: { apiKey: 'secret' } },
      signal(),
    );

    const kept = result.ok ? result.value.map(({ modelId }) => modelId) : [];
    expect(kept).toEqual([
      'gpt-5.5',
      'gpt-3.5-turbo',
      'gpt-realtime-2',
      'gpt-4o-transcribe',
      'whisper-1',
      'tts-1-hd',
      'gpt-audio-1.5',
      'gpt-image-2',
      'chatgpt-image-latest',
    ]);
    expect(
      kept.map((modelId) => openai.resolveModelMetadata?.(modelId)?.kind),
    ).toEqual([
      'language',
      'language',
      'speech-to-speech',
      'speech-to-text',
      'speech-to-text',
      'text-to-speech',
      'language',
      'image-generation',
      'image-generation',
    ]);
  });

  it('lists maintained catalog fallbacks without embedding or image models', () => {
    for (const provider of builtInProviderDefinitions) {
      for (const model of provider.catalogModels ?? []) {
        expect(
          ['language', 'speech-to-speech', 'speech-to-text', 'text-to-speech'],
          `${provider.type}/${model.modelId}`,
        ).toContain(model.kind);
      }
    }
    expect(builtIn('anthropic').catalogModels).toContainEqual(
      expect.objectContaining({
        modelId: 'claude-sonnet-5',
        displayName: 'Claude Sonnet 5',
      }),
    );
    expect(
      builtIn('minimax').catalogModels?.map(({ modelId }) => modelId),
    ).toContain('MiniMax-M3');
    expect(
      builtIn('openai').catalogModels?.map(({ modelId }) => modelId),
    ).not.toContain('omni-moderation-latest');
  });

  it('discovers Mistral capabilities and hides retired or non-chat models', async () => {
    // https://docs.mistral.ai/api/endpoint/models
    vi.setSystemTime(new Date('2026-10-29T00:00:00.000Z'));
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        object: 'list',
        data: [
          {
            id: 'mistral-medium-latest',
            created: 1_775_000_000,
            max_context_length: 131_072,
            capabilities: {
              completion_chat: true,
              function_calling: true,
              vision: true,
            },
            deprecation: null,
          },
          {
            id: 'voxtral-small-latest',
            capabilities: { completion_chat: true, audio: true },
          },
          {
            id: 'voxtral-mini-transcribe-2607',
            capabilities: { completion_chat: false, audio_transcription: true },
          },
          {
            id: 'mistral-large-2407',
            capabilities: { completion_chat: true },
            deprecation: '2025-03-30T12:00:00Z',
          },
          {
            id: 'mistral-small-2609',
            capabilities: { completion_chat: true },
            deprecation: '2027-01-01T00:00:00Z',
          },
          {
            id: 'open-mistral-7b',
            capabilities: { completion_chat: true },
            archived: true,
          },
          { id: 'mistral-embed', capabilities: { completion_chat: false } },
          {
            id: 'mistral-ocr-latest',
            capabilities: { completion_chat: false, ocr: true },
          },
          { id: 'mistral-moderation-latest', capabilities: {} },
          { id: 'future-model' },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await discovery(builtIn('mistral'))(
        { id: 'mistral-1', type: 'mistral', settings: { apiKey: 'secret' } },
        signal(),
      );

      expect(result.ok && result.value).toEqual([
        {
          modelId: 'mistral-medium-latest',
          createdAt: '2026-03-31T23:33:20.000Z',
          kind: 'language',
          contextSize: 131_072,
          capabilities: { input: { image: {} }, tools: true },
        },
        {
          modelId: 'voxtral-small-latest',
          kind: 'language',
          capabilities: { input: { audio: {} } },
        },
        {
          modelId: 'voxtral-mini-transcribe-2607',
          kind: 'speech-to-text',
          capabilities: { input: { audio: {} }, voice: { stt: true } },
        },
        {
          modelId: 'mistral-small-2609',
          kind: 'language',
          capabilities: { input: {} },
        },
        { modelId: 'future-model', capabilities: { input: {} } },
      ]);
      expect(fetchMock.mock.calls[0]?.[1].headers).toMatchObject({
        Authorization: 'Bearer secret',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('discovers xAI input modalities and falls back for proxies', async () => {
    // https://docs.x.ai/docs/api-reference#list-language-models
    const fetchMock = vi.fn().mockResolvedValueOnce(
      Response.json({
        models: [
          {
            id: 'grok-9',
            created: 1_775_000_000,
            input_modalities: ['text', 'image'],
            output_modalities: ['text'],
          },
          {
            id: 'grok-9-code',
            input_modalities: ['text'],
            output_modalities: ['text'],
          },
          {
            id: 'grok-9-image',
            input_modalities: ['text'],
            output_modalities: ['image'],
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const xai = builtIn('xai');
    const result = await discovery(xai)(
      { id: 'xai-1', type: 'xai', settings: { apiKey: 'secret' } },
      signal(),
    );
    expect(result.ok && result.value).toEqual([
      {
        modelId: 'grok-9',
        kind: 'language',
        createdAt: '2026-03-31T23:33:20.000Z',
        capabilities: { input: { image: {} } },
      },
      { modelId: 'grok-9-code', kind: 'language' },
    ]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://api.x.ai/v1/language-models',
    );

    fetchMock
      .mockResolvedValueOnce(new Response('not found', { status: 404 }))
      .mockResolvedValueOnce(
        Response.json({ data: [{ id: 'grok-proxy' }, { id: 'grok-9-image' }] }),
      );
    const proxied = await discovery(xai)(
      {
        id: 'xai-2',
        type: 'xai',
        settings: {
          apiKey: 'secret',
          baseUrl: 'https://proxy.example.test/v1',
        },
      },
      signal(),
    );
    expect(proxied.ok && proxied.value).toEqual([{ modelId: 'grok-proxy' }]);
    expect(String(fetchMock.mock.calls[2]?.[0])).toBe(
      'https://proxy.example.test/v1/models',
    );

    fetchMock.mockResolvedValueOnce(new Response('denied', { status: 401 }));
    await expect(
      discovery(xai)(
        { id: 'xai-3', type: 'xai', settings: { apiKey: 'bad' } },
        signal(),
      ),
    ).resolves.toMatchObject({
      ok: false,
      code: 'discovery_failed',
      message: 'Provider returned HTTP 401',
    });
  });

  it('discovers documented OpenRouter capabilities', async () => {
    // https://openrouter.ai/docs/api-reference/models/get-models
    const openRouter = builtIn('openrouter');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          data: [
            {
              id: 'vendor/model',
              created: 1_688_935_002,
              name: 'Model',
              context_length: 64_000,
              architecture: {
                modality: 'text+image+audio->text',
                input_modalities: ['text', 'image', 'audio'],
                output_modalities: ['text'],
                tokenizer: 'GPT',
              },
              supported_parameters: ['tools', 'reasoning'],
            },
          ],
        }),
      ),
    );
    const openRouterResult = await discovery(openRouter)(
      { id: 'router-1', type: 'openrouter', settings: { apiKey: 'key' } },
      signal(),
    );
    expect(openRouterResult.ok && openRouterResult.value).toEqual([
      {
        modelId: 'vendor/model',
        createdAt: '2023-07-09T20:36:42.000Z',
        displayName: 'Model',
        kind: 'language',
        contextSize: 64_000,
        capabilities: {
          input: { image: {}, audio: {} },
          tools: true,
          reasoning: true,
        },
      },
    ]);
  });

  it('discovers documented Ollama model capabilities', async () => {
    // https://docs.ollama.com/api/tags
    // https://docs.ollama.com/api-reference/show-model-details
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          models: [
            {
              name: 'gemma3:latest',
              modified_at: '2025-08-14T15:49:43.634137516-07:00',
              size: 3_331_880_176,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ capabilities: ['completion', 'vision'] }),
      );
    const provider = builtIn('ollama');

    vi.stubGlobal('fetch', fetchMock);
    const result = await discovery(provider)(
      {
        id: 'ollama-1',
        type: 'ollama',
        settings: { baseUrl: 'http://localhost:11434' },
      },
      signal(),
    );

    expect(result.ok && result.value).toEqual([
      {
        modelId: 'gemma3:latest',
        kind: 'language',
        capabilities: { input: { image: {} } },
      },
    ]);
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).pathname).toBe(
      '/api/tags',
    );
    expect(new URL(String(fetchMock.mock.calls[1]?.[0])).pathname).toBe(
      '/api/show',
    );
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ model: 'gemma3:latest' }),
    });
  });

  it('accepts a valid Codex CLI login for the subscription transport', async () => {
    const provider = builtIn('chatgpt-codex-subscription');
    fsMocks.access.mockResolvedValue(undefined);
    fsMocks.readFile.mockResolvedValue(
      JSON.stringify({
        tokens: {
          access_token: 'header.payload.signature',
          account_id: 'account',
        },
      }),
    );

    await expect(
      provider.preflightCreate?.(
        {
          codexExecutable: '/usr/local/bin/codex',
          authFile: '/home/test/.codex/auth.json',
        },
        signal(),
      ),
    ).resolves.toMatchObject({ ok: true });
    if (!provider.createLanguageModel)
      throw new Error('Missing language factory');
    expect(
      provider.createLanguageModel(
        { id: 'codex-1', type: provider.type, settings: {} },
        'gpt-5-codex',
      ).specificationVersion,
    ).toBe('v4');
  });

  it('discovers picker-visible models from the Codex CLI catalog', async () => {
    const provider = builtIn('chatgpt-codex-subscription');
    fsMocks.readFile.mockResolvedValue(
      JSON.stringify({
        fetched_at: '2026-09-08T00:00:00Z',
        models: [
          {
            slug: 'gpt-visible',
            display_name: 'GPT Visible',
            visibility: 'list',
            supported_in_api: true,
            context_window: 272_000,
            input_modalities: ['text', 'image'],
          },
          {
            slug: 'gpt-hidden',
            display_name: 'GPT Hidden',
            visibility: 'hide',
            supported_in_api: true,
          },
          {
            slug: 'gpt-cli-only',
            display_name: 'GPT CLI Only',
            visibility: 'list',
            supported_in_api: false,
          },
        ],
      }),
    );

    const result = await discovery(provider)(
      {
        id: 'codex-1',
        type: provider.type,
        settings: { authFile: '/custom/codex/auth.json' },
      },
      signal(),
    );

    expect(fsMocks.readFile).toHaveBeenCalledWith(
      '/custom/codex/models_cache.json',
      expect.objectContaining({ encoding: 'utf8' }),
    );
    expect(result).toEqual({
      ok: true,
      code: 'available',
      value: [
        {
          modelId: 'gpt-visible',
          displayName: 'GPT Visible',
          kind: 'language',
          contextSize: 272_000,
          capabilities: { input: { image: {} } },
        },
      ],
    });
  });

  it('uses CODEX_HOME for discovery and controls catalog failures', async () => {
    const provider = builtIn('chatgpt-codex-subscription');
    vi.stubEnv('CODEX_HOME', '/custom/codex-home');
    fsMocks.readFile.mockResolvedValueOnce(JSON.stringify({ models: [] }));

    await discovery(provider)(
      { id: 'codex-1', type: provider.type, settings: {} },
      signal(),
    );
    expect(fsMocks.readFile).toHaveBeenCalledWith(
      '/custom/codex-home/models_cache.json',
      expect.objectContaining({ encoding: 'utf8' }),
    );

    fsMocks.readFile.mockResolvedValueOnce('{invalid');
    await expect(
      discovery(provider)(
        { id: 'codex-1', type: provider.type, settings: {} },
        signal(),
      ),
    ).resolves.toMatchObject({
      ok: false,
      code: 'discovery_failed',
      message: 'Codex model catalog is unavailable or invalid',
    });

    fsMocks.readFile.mockRejectedValueOnce(new Error('ENOENT'));
    await expect(
      discovery(provider)(
        { id: 'codex-1', type: provider.type, settings: {} },
        signal(),
      ),
    ).resolves.toMatchObject({
      ok: false,
      code: 'discovery_failed',
      message: 'Codex model catalog is unavailable or invalid',
    });
  });

  it('normalizes valid settings and constructs every built-in SDK model', () => {
    for (const provider of builtInProviderDefinitions) {
      const settings = parseProviderSettings(
        provider.type,
        validSettings(provider.type),
      );

      const factory =
        provider.createLanguageModel ?? provider.createEvaluationModel;
      if (!factory) throw new Error('Missing inference factory');
      const model = factory(
        {
          id: `${provider.type}-instance`,
          type: provider.type,
          settings,
        },
        'vendor:model:2026-09',
      );
      expect(model.specificationVersion, provider.type).toBe('v4');
      expect(model.modelId, provider.type).toBe('vendor:model:2026-09');
    }
  });

  it('rejects invalid settings without exposing secret values', () => {
    expect(() => parseProviderSettings('openai', {})).toThrow();

    const secret = 'must-never-appear';
    const customError = validationError('chat-completions', {
      baseUrl: 'not a URL',
      apiKey: secret,
    });
    expect(JSON.stringify(customError)).not.toContain(secret);

    expect(() =>
      parseProviderSettings('google-vertex', {
        authMode: 'service-account',
        project: 'p',
      }),
    ).toThrow();
    const vertexError = validationError('google-vertex', {
      authMode: 'service-account',
      project: 'p',
      googleCredentials: secret,
    });
    expect(JSON.stringify(vertexError)).not.toContain(secret);
  });

  it('accepts environment-only URLs and rejects array credentials', () => {
    expect(
      parseProviderSettings('ollama', { baseUrl: `\${env:OLLAMA_URL}` }),
    ).toEqual({ baseUrl: `\${env:OLLAMA_URL}` });
    expect(() =>
      parseProviderSettings('google-vertex', {
        authMode: 'service-account',
        googleCredentials: '[]',
      }),
    ).toThrow('Must be a JSON object or environment reference');
  });

  it('marks secrets inside discriminated settings variants', () => {
    const registry = createProviderRegistry({
      logging,
      definitions: builtInProviderDefinitions,
    });
    const vertex = registry
      .listProviderTypes()
      .find((provider) => provider.type === 'google-vertex');
    expect(vertex?.settingsSchema).toMatchObject({
      oneOf: expect.arrayContaining([
        expect.objectContaining({
          properties: expect.objectContaining({
            googleCredentials: expect.objectContaining({
              format: 'password',
              writeOnly: true,
            }),
          }),
        }),
      ]),
    });
  });

  it('maps OpenAI discovery and preserves native model IDs containing colons', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        data: [
          { id: 'vendor:model:2026-09' },
          { id: 'text-embedding-3-small' },
          { invalid: true },
        ],
      }),
    );
    const provider = builtIn('openai');
    vi.stubGlobal('fetch', fetchMock);
    const result = await discovery(provider)(
      {
        id: 'work',
        type: 'openai',
        settings: { apiKey: 'secret' },
      },
      signal(),
    );

    expect(result).toEqual({
      ok: true,
      code: 'available',
      value: [{ modelId: 'vendor:model:2026-09' }],
    });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: 'Bearer secret' },
    });
  });

  it('reports connectivity success and sanitized upstream failures', async () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(100).mockReturnValueOnce(107);
    const provider = builtIn('openai');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ data: [] })),
    );
    await expect(
      provider.testConnection(
        {
          id: 'work',
          type: 'openai',
          settings: { apiKey: 'secret' },
        },
        signal(),
      ),
    ).resolves.toEqual({
      ok: true,
      code: 'available',
      value: { latencyMs: 7, target: 'https://api.openai.com' },
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('secret-body', { status: 401 })),
    );
    const failed = await provider.testConnection(
      {
        id: 'work',
        type: 'openai',
        settings: { apiKey: 'top-secret' },
      },
      signal(),
    );
    expect(failed).toMatchObject({
      ok: false,
      code: 'connectivity_failed',
      message: 'Provider returned HTTP 401',
    });
    expect(JSON.stringify(failed)).not.toContain('top-secret');
    expect(JSON.stringify(failed)).not.toContain('secret-body');
  });

  it('maps aborted HTTP boundaries to discovery and connectivity failures', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Timed out', 'AbortError')),
          );
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const provider = builtIn('openai');
    const pending = provider.testConnection(
      {
        id: 'work',
        type: 'openai',
        settings: { apiKey: 'secret' },
      },
      controller.signal,
    );
    controller.abort();

    await expect(pending).resolves.toMatchObject({
      ok: false,
      code: 'connectivity_failed',
      message: 'Request timed out',
    });
  });

  it('reports missing and invalid Codex authentication state', async () => {
    const provider = builtIn('chatgpt-codex-subscription');
    await expect(
      provider.preflightCreate?.({}, signal()),
    ).resolves.toMatchObject({
      ok: false,
      code: 'dependency_missing',
    });

    fsMocks.access.mockResolvedValue(undefined);
    fsMocks.readFile.mockResolvedValue('{}');
    await expect(
      provider.preflightCreate?.({}, signal()),
    ).resolves.toMatchObject({
      ok: false,
      code: 'authentication_required',
    });
  });

  it('checks Ollama availability through fetch', async () => {
    const provider = builtIn('ollama');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ models: [] })),
    );
    await expect(
      provider.preflightCreate?.({}, signal()),
    ).resolves.toMatchObject({
      ok: true,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    );
    await expect(
      provider.preflightCreate?.({}, signal()),
    ).resolves.toMatchObject({
      ok: false,
      code: 'connectivity_failed',
      message: 'Ollama is not reachable',
    });
  });

  it('rejects definitions without complete usage guidance', () => {
    const invalid = definition('openai');
    invalid.usageGuidance = '';
    expect(() =>
      createProviderRegistry({
        logging,
        definitions: [invalid],
      }),
    ).toThrow('must include complete usage guidance');
  });

  it('rejects duplicate provider types', () => {
    expect(() =>
      createProviderRegistry({
        logging,
        definitions: [definition('openai'), definition('openai')],
      }),
    ).toThrow("Duplicate provider type 'openai'");
  });

  it('rejects undeclared fields and replaces declared secrets with configured markers', () => {
    const item = definition('openai');
    const registry = createProviderRegistry({
      logging,
      definitions: [item],
    });
    expect(() =>
      registry.serializeSettings('openai', {
        apiKey: 'top-secret',
        undeclaredSecret: 'must-not-leak',
      }),
    ).toThrow();
    expect(
      registry.serializeSettings('openai', { apiKey: 'top-secret' }),
    ).toEqual({ apiKey: { configured: true } });

    const customRegistry = createProviderRegistry({
      logging,
      definitions: [definition('chat-completions')],
    });
    expect(
      customRegistry.serializeSettings('chat-completions', {
        baseUrl: 'https://example.test/v1',
        headers: { Authorization: 'Bearer top-secret' },
      }),
    ).toEqual({
      baseUrl: 'https://example.test/v1',
      headers: { configured: true },
    });
  });

  it('rejects unsafe SVG logos', () => {
    const invalid = definition('openai');
    invalid.metadata = {
      ...invalid.metadata,
      logoSvg: '<svg><script>alert(1)</script></svg>',
    };
    expect(() =>
      createProviderRegistry({
        logging,
        definitions: [invalid],
      }),
    ).toThrow('unsafe SVG');
  });
});
