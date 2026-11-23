import type { JSONSchema7, LanguageModelV4CallOptions } from '@ai-sdk/provider';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getProviderSettingsJsonSchema, parseProviderSettings } from '@/config';

import type {
  ProviderContext,
  ProviderInstance,
  ProviderModel,
} from '../provider-registry';
import { langdockProviderDefinition as provider } from './langdock';

const googleAdapterCall = vi.hoisted(() => vi.fn());
vi.mock('@ai-sdk/google', async (importOriginal) => {
  const original = await importOriginal<typeof import('@ai-sdk/google')>();
  return {
    ...original,
    createGoogle: (...args: Parameters<typeof original.createGoogle>) => {
      const google = original.createGoogle(...args);
      const languageModel = google.languageModel.bind(google);
      google.languageModel = (...modelArgs) => {
        const model = languageModel(...modelArgs);
        const generate = model.doGenerate.bind(model);
        const stream = model.doStream.bind(model);
        vi.spyOn(model, 'doGenerate').mockImplementation((options) => {
          googleAdapterCall(options);
          return generate(options);
        });
        vi.spyOn(model, 'doStream').mockImplementation((options) => {
          googleAdapterCall(options);
          return stream(options);
        });
        return model;
      };
      return google;
    },
  };
});

const instance: ProviderInstance = {
  id: 'langdock',
  type: 'langdock',
  settings: {
    apiKey: 'synthetic',
    headers: { 'X-Custom': 'value', authorization: 'wrong' },
  },
};
const signal = () => new AbortController().signal;
const context = (models: readonly ProviderModel[]): ProviderContext => ({
  credential: async () => undefined,
  invalidate: async () => undefined,
  discoveredModel: (id) => models.find((model) => model.modelId === id),
});
afterEach(() => vi.unstubAllGlobals());

describe('Langdock', () => {
  it('validates settings, defaults region, and marks secrets', () => {
    expect(parseProviderSettings('langdock', { apiKey: 'synthetic' })).toEqual({
      apiKey: 'synthetic',
      region: 'eu',
    });
    for (const settings of [
      { apiKey: '' },
      { apiKey: 'key', region: 'apac' },
      { apiKey: 'key', baseUrl: 'invalid' },
      { apiKey: 'key', headers: { a: 1 } },
    ])
      expect(() => parseProviderSettings('langdock', settings)).toThrow();
    expect(getProviderSettingsJsonSchema('langdock')).toMatchObject({
      properties: { apiKey: { writeOnly: true }, headers: { writeOnly: true } },
    });
  });

  it.each([
    ['gpt-4o', 'openai.chat', 'gpt-4o'],
    [
      'claude-sonnet-4-6-default',
      'anthropic.messages',
      'claude-sonnet-4-6-default',
    ],
    [
      'eu.anthropic.claude-custom',
      'anthropic.messages',
      'eu.anthropic.claude-custom',
    ],
    [
      'us.anthropic.claude-custom',
      'anthropic.messages',
      'us.anthropic.claude-custom',
    ],
    ['models/gemini-2.5-pro', 'google.generative-ai', 'gemini-2.5-pro'],
    ['anthropic/custom', 'anthropic.messages', 'custom'],
    ['google/custom', 'google.generative-ai', 'custom'],
    ['openai/claude-custom', 'openai.chat', 'claude-custom'],
  ])('routes %s to %s', (id, sdk, upstreamId) => {
    const model = provider.createLanguageModel(instance, id);
    expect(model.provider).toBe(sdk);
    expect(model.modelId).toBe(upstreamId);
  });

  it.each([
    'gpt-4o',
    'anthropic/claude-sonnet-4-6-default',
    'eu.anthropic.claude-sonnet-4-6-default',
    'models/gemini-2.5-pro',
    'openai/gpt-oss-120b',
  ])('resolves metadata for %s', (id) => {
    expect(provider.resolveModelMetadata(id)?.kind).toBe('language');
  });

  it.each([
    ['openai/gpt-4o', '/openai/us/v1/chat/completions'],
    ['anthropic/claude-custom', '/anthropic/us/v1/messages'],
    [
      'google/gemini-custom',
      '/google/us/v1beta/models/gemini-custom:generateContent',
    ],
  ])('sends generation through %s with Bearer auth', async (id, path) => {
    const requests: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init) => {
        requests.push({ url: String(url), init });
        return new Response('{}', { status: 400 });
      }),
    );
    const model = provider.createLanguageModel(
      {
        ...instance,
        settings: {
          ...instance.settings,
          region: 'us',
          baseUrl: 'https://gateway.example/proxy/openai/eu/v1///',
        },
      },
      id,
    );
    await expect(
      model.doGenerate({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      }),
    ).rejects.toThrow();
    expect(requests).toHaveLength(1);
    const request = requests[0];
    if (!request) throw new Error('Missing generation request');
    expect(request.url).toBe(`https://gateway.example/proxy${path}`);
    const headers = new Headers(request.init.headers);
    expect(headers.get('authorization')).toBe('Bearer synthetic');
    expect(headers.get('x-custom')).toBe('value');
    expect(new URL(request.url).searchParams.has('key')).toBe(false);
    if (!id.startsWith('google'))
      expect(JSON.parse(String(request.init.body)).model).toBe(
        id.split('/')[1],
      );
  });

  it('discovers concurrently, paginates, filters, and retains custom/colliding routes', async () => {
    const calls: URL[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input, init) => {
        const url = new URL(String(input));
        calls.push(url);
        expect(new Headers(init.headers).get('authorization')).toBe(
          'Bearer synthetic',
        );
        expect(init.signal).toBeDefined();
        // Yield once: all three initial protocol calls must have started.
        await Promise.resolve();
        expect(calls.length).toBeGreaterThanOrEqual(3);
        if (url.pathname.includes('/openai/'))
          return Response.json({
            data: [
              { id: 'shared', created: 1700000000 },
              { id: 'text-embedding-3-small' },
            ],
          });
        if (url.pathname.includes('/anthropic/'))
          return Response.json(
            url.searchParams.has('after_id')
              ? {
                  data: [
                    {
                      id: 'custom-anthropic',
                      display_name: 'Custom',
                      max_input_tokens: 12345,
                      capabilities: { thinking: { supported: true } },
                    },
                  ],
                }
              : { data: [{ id: 'shared' }], has_more: true, last_id: 'shared' },
          );
        return Response.json(
          url.searchParams.has('pageToken')
            ? {
                models: [
                  {
                    name: 'models/embedding-custom',
                    supportedGenerationMethods: ['embedContent'],
                  },
                ],
              }
            : {
                models: [
                  {
                    name: 'models/custom-google',
                    inputTokenLimit: 1234,
                    supportedGenerationMethods: ['generateContent'],
                  },
                ],
                nextPageToken: 'next',
              },
        );
      }),
    );
    const result = await provider.discoverModels(instance, signal());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.partial).toBe(false);
    expect(calls).toHaveLength(5);
    expect(calls.every((url) => !url.searchParams.has('key'))).toBe(true);
    expect(result.value.map((model) => model.modelId)).not.toContain(
      'text-embedding-3-small',
    );
    expect(
      result.value.find((model) => model.modelId === 'custom-anthropic'),
    ).toMatchObject({
      displayName: 'Custom',
      contextSize: 12345,
      capabilities: { reasoning: true },
    });
    expect(
      result.value.find((model) => model.modelId === 'embedding-custom')?.kind,
    ).toBe('embedding');
    for (const [id, sdk] of [
      ['shared', 'openai.chat'],
      ['openai/shared', 'openai.chat'],
      ['anthropic/shared', 'anthropic.messages'],
      ['custom-anthropic', 'anthropic.messages'],
      ['custom-google', 'google.generative-ai'],
    ])
      expect(
        provider.createLanguageModel(instance, id ?? '', context(result.value))
          .provider,
      ).toBe(sdk);
    expect(JSON.stringify(result.value)).not.toContain('upstreamId');
  });

  it('isolates malformed endpoints and loops; checks connectivity without inference', async () => {
    const fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('/openai/')) return Response.json({ invalid: true });
      if (url.includes('/anthropic/'))
        return Response.json({ data: [], has_more: true, last_id: 'repeat' });
      return Response.json({ models: [] });
    });
    vi.stubGlobal('fetch', fetch);
    expect(await provider.discoverModels(instance, signal())).toMatchObject({
      ok: true,
      partial: true,
      value: [],
    });
    expect(await provider.testConnection(instance, signal())).toMatchObject({
      ok: true,
    });
    expect(
      fetch.mock.calls.every(([url]) => String(url).includes('/models')),
    ).toBe(true);
  });

  it('does not overwrite literal IDs that look like collision aliases', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input) => {
        if (String(input).includes('/google/'))
          return Response.json({ models: [] });
        return Response.json({
          data: String(input).includes('/openai/')
            ? [{ id: 'shared' }, { id: 'anthropic/shared' }]
            : [{ id: 'shared' }],
        });
      }),
    );
    const result = await provider.discoverModels(instance, signal());
    if (!result.ok) throw new Error('Discovery failed');
    const literal = provider.createLanguageModel(
      instance,
      'anthropic/shared',
      context(result.value),
    );
    expect(literal.provider).toBe('openai.chat');
    expect(literal.modelId).toBe('anthropic/shared');
    const alias = provider.createLanguageModel(
      instance,
      'anthropic/anthropic/shared',
      context(result.value),
    );
    expect(alias.provider).toBe('anthropic.messages');
    expect(alias.modelId).toBe('shared');
  });

  it('passes cancellation to every concurrent discovery request', async () => {
    const controller = new AbortController();
    const fetch = vi.fn(
      async (_input, init) =>
        new Promise((_resolve, reject) => {
          expect(init.signal).toBe(controller.signal);
          init.signal.addEventListener(
            'abort',
            () => reject(new Error('aborted')),
            { once: true },
          );
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const result = provider.discoverModels(instance, controller.signal);
    expect(fetch).toHaveBeenCalledTimes(3);
    controller.abort();
    expect(await result).toMatchObject({ ok: false, code: 'discovery_failed' });
  });

  it('fails safely if every protocol fails or is aborted', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('Bearer synthetic https://private.example');
      }),
    );
    const result = await provider.discoverModels(instance, signal());
    expect(result).toMatchObject({ ok: false, code: 'discovery_failed' });
    expect(JSON.stringify(result)).not.toContain('synthetic');
    expect(await provider.testConnection(instance, signal())).toMatchObject({
      ok: false,
      code: 'connectivity_failed',
    });
  });

  it('preserves Google tool-result $ref adaptation', async () => {
    let body: unknown;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input, init) => {
        body = JSON.parse(init.body);
        return new Response('{}', { status: 400 });
      }),
    );
    const model = provider.createLanguageModel(
      instance,
      'google/gemini-custom',
    );
    await expect(
      model.doGenerate({
        prompt: [
          {
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolCallId: 'call',
                toolName: 'lookup',
                output: {
                  type: 'json',
                  value: { $ref: '#/secret', nested: 'preserved' },
                },
              },
            ],
          },
        ],
      }),
    ).rejects.toThrow();
    expect(JSON.stringify(body)).toContain('preserved');
    expect(JSON.stringify(body)).not.toContain('"$ref":');
  });

  it.each([false, true])(
    'adapts Google recursive schemas and remote files (streaming=%s)',
    async (streaming) => {
      googleAdapterCall.mockClear();
      // Inline the JSON-value union so both JSON Schema and the older OpenAPI
      // serializer retain it (the latter does not resolve $defs).
      const schema: JSONSchema7 = {
        type: 'object',
        required: ['body'],
        properties: {
          body: {
            anyOf: [
              { type: 'string' },
              { type: 'number' },
              { type: 'boolean' },
              { type: 'null' },
              { type: 'array', items: { $ref: '#/properties/body' } },
              {
                type: 'object',
                additionalProperties: { $ref: '#/properties/body' },
              },
            ],
          },
        },
      };
      const before = structuredClone(schema);
      const requests: {
        tools: {
          functionDeclarations: {
            name: string;
            parametersJsonSchema?: JSONSchema7;
            parameters?: JSONSchema7;
          }[];
        }[];
        contents: { parts: { fileData?: { fileUri: string } }[] }[];
      }[] = [];
      const fetch = vi.fn(async (_input, init) => {
        requests.push(JSON.parse(init.body));
        return new Response('{}', { status: 400 });
      });
      vi.stubGlobal('fetch', fetch);
      const model = provider.createLanguageModel(
        instance,
        'google/gemini-custom',
      );
      const options: LanguageModelV4CallOptions = {
        tools: [{ type: 'function', name: 'lookup', inputSchema: schema }],
        prompt: [
          {
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolCallId: 'call',
                toolName: 'lookup',
                output: {
                  type: 'content',
                  value: [
                    {
                      type: 'file',
                      mediaType: 'application/pdf',
                      data: {
                        type: 'url',
                        url: new URL('https://media.example/document.pdf'),
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };
      await expect(
        streaming ? model.doStream(options) : model.doGenerate(options),
      ).rejects.toThrow();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(googleAdapterCall).toHaveBeenCalledTimes(1);
      const adaptedSchema =
        googleAdapterCall.mock.calls[0]?.[0].tools[0].inputSchema;
      expect(adaptedSchema).toEqual({
        ...schema,
        properties: {
          body: {
            anyOf: [
              { type: 'string' },
              { type: 'number' },
              { type: 'boolean' },
              { type: 'null' },
              { type: 'array', items: {} },
              { type: 'object', additionalProperties: true },
            ],
          },
        },
      });
      const request = requests[0];
      if (!request) throw new Error('Missing request');
      const declaration = request.tools[0]?.functionDeclarations[0];
      expect(declaration?.name).toBe('lookup');
      // Google SDK releases serialize either JSON Schema or OpenAPI parameters.
      const sent = declaration?.parametersJsonSchema ?? declaration?.parameters;
      expect(schema).toEqual(before);
      expect(sent).toEqual({
        type: 'object',
        required: ['body'],
        properties: {
          body: declaration?.parametersJsonSchema
            ? {
                anyOf: [
                  { type: 'string' },
                  { type: 'number' },
                  { type: 'boolean' },
                  { type: 'null' },
                  { type: 'array', items: {} },
                  { type: 'object', additionalProperties: true },
                ],
              }
            : {
                nullable: true,
                anyOf: [
                  { type: 'string' },
                  { type: 'number' },
                  { type: 'boolean' },
                  { type: 'array', items: {} },
                  { type: 'object' },
                ],
              },
        },
      });
      expect(JSON.stringify(sent)).not.toContain('$ref');
      expect(
        request.contents
          .flatMap((content) => content.parts)
          .filter((part) => part.fileData),
      ).toEqual([
        {
          fileData: {
            mimeType: 'application/pdf',
            fileUri: 'https://media.example/document.pdf',
          },
        },
      ]);
    },
  );
});
