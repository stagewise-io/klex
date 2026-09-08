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
    ]);
    for (const item of definitions) {
      expect(item.metadata.displayName).not.toBe('');
      expect(item.metadata.description).not.toBe('');
      expect(item.usageGuidance.length).toBeGreaterThan(40);
    }
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

    expect(result.ok && result.value).toEqual([{ modelId: 'gpt-test' }]);
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
          ],
          nextPageToken: 'next-page',
        }),
      )
      .mockResolvedValueOnce(Response.json({ models: [] }));
    vi.stubGlobal('fetch', googleFetch);
    const googleResult = await discovery(google)(
      { id: 'google-1', type: 'google-gemini', settings: { apiKey: 'key' } },
      signal(),
    );
    expect(googleResult.ok && googleResult.value).toEqual([
      {
        modelId: 'gemini-test',
        displayName: 'Gemini Test',
        contextSize: 32_000,
        kind: 'language',
      },
      { modelId: 'embed-test', kind: 'embedding' },
    ]);
    expect(
      new URL(String(googleFetch.mock.calls[0]?.[0])).searchParams.get('key'),
    ).toBe('key');
    expect(
      new URL(String(googleFetch.mock.calls[1]?.[0])).searchParams.get(
        'pageToken',
      ),
    ).toBe('next-page');
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
    expect(
      provider.createLanguageModel(
        { id: 'codex-1', type: provider.type, settings: {} },
        'gpt-5-codex',
      ).specificationVersion,
    ).toBe('v4');
  });

  it('normalizes valid settings and constructs every built-in SDK model', () => {
    for (const provider of builtInProviderDefinitions) {
      const settings = parseProviderSettings(
        provider.type,
        validSettings(provider.type),
      );

      const model = provider.createLanguageModel(
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
      value: [
        { modelId: 'vendor:model:2026-09' },
        { modelId: 'text-embedding-3-small' },
      ],
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
