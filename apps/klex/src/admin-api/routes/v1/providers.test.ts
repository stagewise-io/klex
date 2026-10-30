import type { OpenAPIHono } from '@hono/zod-openapi';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ModuleLogger } from '@stagewise/logger';

import type { ProviderRegistry } from '@/provider-registry';

import {
  canAddProvider,
  canAddProviderRoute,
  createKnownModel,
  createKnownModelRoute,
  createProvider,
  createProviderRoute,
  deleteKnownModel,
  deleteKnownModelRoute,
  deleteProvider,
  deleteProviderRoute,
  getProviderModels,
  getProviderModelsRoute,
  getProviders,
  getProvidersRoute,
  getProviderTypes,
  getProviderTypesRoute,
  getProviderVoices,
  getProviderVoicesRoute,
  getVoicePreview,
  getVoicePreviewRoute,
  type ProviderRouteDependencies,
  testProvider,
  testProviderRoute,
  updateKnownModel,
  updateKnownModelRoute,
  updateProvider,
  updateProviderRoute,
} from './providers';
import { setupTestApp } from './test-utils';

const metadata = {
  displayName: 'Test Provider',
  description: 'Test transport',
  capabilities: {
    modelDiscovery: true,
    voiceDiscovery: true,
    voicePreview: true,
    connectivityTest: true,
    customModels: true,
    generation: true,
    evaluation: false,
  },
};
const instance = {
  id: 'test-main',
  type: 'openai' as const,
  settings: { apiKey: { configured: true } },
  metadata,
  operations: {
    update: { available: true as const },
    remove: { available: true as const },
  },
};

function makeApp(registry: Partial<ProviderRegistry>): OpenAPIHono {
  const deps: ProviderRouteDependencies = {
    logger: { error: () => undefined } as unknown as ModuleLogger,
    providerRegistry: registry as ProviderRegistry,
  };
  return setupTestApp((app) => {
    app.openapi(getProviderTypesRoute, getProviderTypes(deps));
    app.openapi(canAddProviderRoute, canAddProvider(deps));
    app.openapi(getProvidersRoute, getProviders(deps));
    app.openapi(createProviderRoute, createProvider(deps));
    app.openapi(updateProviderRoute, updateProvider(deps));
    app.openapi(deleteProviderRoute, deleteProvider(deps));
    app.openapi(testProviderRoute, testProvider(deps));
    app.openapi(getProviderModelsRoute, getProviderModels(deps));
    app.openapi(getProviderVoicesRoute, getProviderVoices(deps));
    app.openapi(getVoicePreviewRoute, getVoicePreview(deps));
    app.openapi(createKnownModelRoute, createKnownModel(deps));
    app.openapi(updateKnownModelRoute, updateKnownModel(deps));
    app.openapi(deleteKnownModelRoute, deleteKnownModel(deps));
  });
}

afterEach(() => vi.restoreAllMocks());

describe('provider registry routes', () => {
  it('lists voices scoped to opaque model IDs without previewing', async () => {
    const listVoices = vi.fn(async () => ({
      ok: true as const,
      code: 'available' as const,
      value: { voices: [] },
    }));
    const getVoicePreview = vi.fn();
    const app = makeApp({ listVoices, getVoicePreview });
    const response = await app.request(
      '/v1/providers/test-main/voices?modelId=models%2Fopaque%3Amodel&refresh=true',
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      voices: [],
    });
    expect(listVoices).toHaveBeenCalledWith(
      'test-main',
      'models/opaque:model',
      true,
      expect.any(AbortSignal),
    );
    expect(getVoicePreview).not.toHaveBeenCalled();
    expect((await app.request('/v1/providers/test-main/voices')).status).toBe(
      400,
    );
  });

  it('exposes the simplified voice contract with optional descriptions and catalog state', async () => {
    const catalog = {
      defaultVoiceId: 'cedar',
      stale: true,
      voices: [
        {
          voiceId: 'cedar',
          displayName: 'Cedar',
          description: 'Warm voice',
          isPreviewAvailable: true,
        },
        {
          voiceId: 'other',
          displayName: 'Other',
          isPreviewAvailable: false,
        },
      ],
    };
    const app = makeApp({
      listVoices: async () => ({ ok: true, code: 'available', value: catalog }),
    });
    const response = await app.request(
      '/v1/providers/test-main/voices?modelId=gpt-realtime',
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(catalog);
  });

  it('returns binary preview bytes and private headers; rejects arbitrary preview inputs', async () => {
    const audio = new Uint8Array([82, 73, 70, 70, 0, 128, 255]);
    const getVoicePreview = vi.fn(async () => ({
      ok: true as const,
      code: 'available' as const,
      value: {
        audio,
        mimeType: 'audio/wav' as const,
        sourceModelId: 'models/opaque:model',
        mode: 'live' as const,
      },
    }));
    const app = makeApp({ getVoicePreview });
    const request = (body: unknown) =>
      app.request('/v1/providers/test-main/voices/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const response = await request({
      modelId: 'models/opaque:model',
      voiceId: 'Puck',
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/wav');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-voice-preview-mode')).toBe('live');
    expect(
      decodeURIComponent(response.headers.get('x-voice-preview-model') ?? ''),
    ).toBe('models/opaque:model');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(audio);
    expect(getVoicePreview).toHaveBeenCalledWith(
      'test-main',
      'models/opaque:model',
      'Puck',
      expect.any(AbortSignal),
    );
    expect(
      (await request({ modelId: 'm', voiceId: 'Puck', text: 'arbitrary' }))
        .status,
    ).toBe(400);
    expect(getVoicePreview).toHaveBeenCalledTimes(1);
  });

  it('returns HTTP 429 when voice discovery is at capacity', async () => {
    const app = makeApp({
      listVoices: async () => ({
        ok: false,
        code: 'rate_limited',
        message: 'Voice discovery limit reached; retry later',
      }),
    });
    const response = await app.request(
      '/v1/providers/test-main/voices?modelId=gpt-live-1',
    );
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ code: 'rate_limited' });
  });

  it('maps preview failures to stable HTTP statuses', async () => {
    for (const [code, status] of [
      ['not_found', 404],
      ['rate_limited', 429],
      ['preview_failed', 502],
      ['unsupported_operation', 400],
      ['authentication_required', 400],
      ['internal_error', 500],
    ] as const) {
      const app = makeApp({
        getVoicePreview: vi.fn(async () => ({
          ok: false as const,
          code,
          message: 'Unavailable',
        })),
      });
      const response = await app.request(
        '/v1/providers/test-main/voices/preview',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ modelId: 'm', voiceId: 'v' }),
        },
      );
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: 'Unavailable', code });
    }
  });
  it('does not expose the removed synthetic operation endpoint', async () => {
    const resolveInstinctCandidates = vi.fn();
    const response = await makeApp({ resolveInstinctCandidates }).request(
      '/v1/providers/test-main/operation-test',
      { method: 'POST' },
    );
    expect(response.status).toBe(404);
    expect(resolveInstinctCandidates).not.toHaveBeenCalled();
  });

  it('exposes provider metadata and redacted instance settings', async () => {
    const app = makeApp({
      listProviderTypes: () => [
        { type: 'openai', ...metadata, settingsSchema: {} },
      ],
      listInstances: () => [instance],
    });
    const types = await app.request('/v1/provider-types');
    expect(await types.json()).toMatchObject({
      providerTypes: [{ type: 'openai', displayName: 'Test Provider' }],
    });
    const providers = await app.request('/v1/providers');
    expect(await providers.json()).toMatchObject({
      providers: [
        { id: 'test-main', settings: { apiKey: { configured: true } } },
      ],
    });
  });

  it('documents and sanitizes provider export failures', async () => {
    const app = makeApp({
      listInstances: () => {
        throw new Error('Unresolved environment reference: PRIVATE_KEY');
      },
    });
    const document = app.getOpenAPI31Document({
      openapi: '3.1.0',
      info: { title: 'Test', version: '1.0.0' },
    });
    expect(
      document.paths?.['/v1/providers']?.get?.responses?.['500'],
    ).toMatchObject({
      description: 'Internal error',
      content: { 'application/json': { schema: expect.any(Object) } },
    });
    const response = await app.request('/v1/providers?includeSecrets=true');
    expect(response.status).toBe(500);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual({
      error: 'Internal server error',
      code: 'internal_error',
    });
  });

  it.each([undefined, 'false', 'true'])(
    'exports secrets only with explicit includeSecrets=%s and acknowledges support',
    async (flag) => {
      const includeSecrets = flag === 'true';
      const listInstances = vi.fn<ProviderRegistry['listInstances']>(
        (options) => [
          {
            ...instance,
            settings: options?.includeSecrets
              ? { apiKey: 'test-secret' }
              : instance.settings,
          },
        ],
      );
      const response = await makeApp({ listInstances }).request(
        `/v1/providers${flag ? `?includeSecrets=${flag}` : ''}`,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(await response.json()).toEqual({
        providers: [
          {
            ...instance,
            settings: includeSecrets
              ? { apiKey: 'test-secret' }
              : instance.settings,
          },
        ],
        ...(includeSecrets ? { secretsIncluded: true } : {}),
      });
      expect(listInstances).toHaveBeenCalledWith({ includeSecrets });
    },
  );

  it.each([
    '1',
    'TRUE',
    '',
    'false&includeSecrets=true',
    'true&includeSecrets=false',
    'true&includeSecrets=true',
  ])(
    'rejects ambiguous includeSecrets=%s without reading secrets',
    async (flag) => {
      const listInstances = vi.fn<ProviderRegistry['listInstances']>(() => []);
      const response = await makeApp({ listInstances }).request(
        `/v1/providers?includeSecrets=${flag}`,
      );
      expect(response.status).toBe(400);
      expect(listInstances).not.toHaveBeenCalled();
    },
  );

  it('returns stable prerequisite failure codes', async () => {
    const app = makeApp({
      preflightCreate: vi.fn(async () => ({
        ok: false as const,
        code: 'dependency_missing' as const,
        message: 'CLI missing',
        remediation: 'Install the provider CLI',
      })),
    });
    const response = await app.request('/v1/provider-types/openai/can-add', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings: {} }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'CLI missing',
      code: 'dependency_missing',
      remediation: 'Install the provider CLI',
    });
  });

  it('creates instances through lifecycle hooks', async () => {
    const addInstance = vi.fn(async () => ({
      ok: true as const,
      code: 'available' as const,
      value: instance,
    }));
    const app = makeApp({ addInstance });
    const response = await app.request('/v1/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'test-main',
        type: 'openai',
        settings: { apiKey: 'secret' },
      }),
    });
    expect(response.status).toBe(201);
    expect(addInstance).toHaveBeenCalledWith({
      id: 'test-main',
      type: 'openai',
      settings: { apiKey: 'secret' },
    });
  });

  it('returns 404 for missing provider mutations', async () => {
    const missing = {
      ok: false as const,
      code: 'not_found' as const,
      message: 'Unknown provider',
    };
    const app = makeApp({
      updateInstance: vi.fn(async () => missing),
      removeInstance: vi.fn(async () => missing),
    });

    const updated = await app.request('/v1/providers/missing', {
      method: 'PATCH',
      headers: { 'content-type': 'application/merge-patch+json' },
      body: JSON.stringify({ settings: {} }),
    });
    const removed = await app.request('/v1/providers/missing', {
      method: 'DELETE',
    });

    expect(updated.status).toBe(404);
    expect(removed.status).toBe(404);
  });

  it('forwards model refresh and returns merged model sources', async () => {
    const listModels = vi.fn(async () => ({
      ok: true as const,
      code: 'available' as const,
      value: {
        models: [
          {
            modelId: 'vendor:model:latest',
            createdAt: '2026-01-02T00:00:00.000Z',
            displayName: 'Latest',
            source: 'merged' as const,
          },
        ],
        discovery: {
          status: 'live' as const,
          fetchedAt: '2026-10-29T10:00:00.000Z',
        },
      },
    }));
    const app = makeApp({ listModels });
    const response = await app.request(
      '/v1/providers/test-main/models?refresh=true',
    );

    expect(response.status).toBe(200);
    expect(listModels).toHaveBeenCalledWith('test-main', true);
    expect(await response.json()).toEqual({
      models: [
        {
          modelId: 'vendor:model:latest',
          createdAt: '2026-01-02T00:00:00.000Z',
          displayName: 'Latest',
          source: 'merged',
        },
      ],
      discovery: { status: 'live', fetchedAt: '2026-10-29T10:00:00.000Z' },
    });
  });

  it('returns catalog fallback models with the discovery issue', async () => {
    const app = makeApp({
      listModels: vi.fn(async () => ({
        ok: true as const,
        code: 'available' as const,
        value: {
          models: [
            {
              modelId: 'gpt-5.5',
              kind: 'language' as const,
              source: 'catalog' as const,
            },
          ],
          discovery: {
            status: 'catalog' as const,
            issue: {
              code: 'discovery_failed' as const,
              message: 'Provider returned HTTP 503',
            },
          },
        },
      })),
    });

    const response = await app.request('/v1/providers/test-main/models');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      models: [{ modelId: 'gpt-5.5', kind: 'language', source: 'catalog' }],
      discovery: {
        status: 'catalog',
        issue: {
          code: 'discovery_failed',
          message: 'Provider returned HTTP 503',
        },
      },
    });
  });

  it('scopes manual model mutations to the provider instance', async () => {
    const addKnownModel = vi.fn(async () => ({
      ok: true as const,
      code: 'available' as const,
      value: undefined,
    }));
    const updateKnownModel = vi.fn(addKnownModel);
    const removeKnownModel = vi.fn(addKnownModel);
    const listModels = vi.fn(async () => ({
      ok: true as const,
      code: 'available' as const,
      value: { models: [] },
    }));
    const app = makeApp({
      addKnownModel,
      updateKnownModel,
      removeKnownModel,
      listModels,
    });

    const created = await app.request('/v1/providers/test-main/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelId: 'vendor:model', displayName: 'Model' }),
    });
    expect(created.status).toBe(200);
    expect(addKnownModel).toHaveBeenCalledWith('test-main', 'vendor:model', {
      displayName: 'Model',
    });

    const updated = await app.request(
      '/v1/providers/test-main/models/vendor%3Amodel',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contextSize: 128000 }),
      },
    );
    expect(updated.status).toBe(200);
    expect(updateKnownModel).toHaveBeenCalledWith('test-main', 'vendor:model', {
      contextSize: 128000,
    });

    const removed = await app.request(
      '/v1/providers/test-main/models/vendor%3Amodel',
      { method: 'DELETE' },
    );
    expect(removed.status).toBe(200);
    expect(removeKnownModel).toHaveBeenCalledWith('test-main', 'vendor:model');
  });

  it('reports discovery and connectivity failures as operational errors', async () => {
    const failure = {
      ok: false as const,
      code: 'authentication_required' as const,
      message: 'Invalid credentials',
      remediation: 'Update credentials',
    };
    const app = makeApp({
      listModels: vi.fn(async () => failure),
      testConnection: vi.fn(async () => failure),
    });

    const models = await app.request('/v1/providers/test-main/models');
    expect(models.status).toBe(400);
    expect(await models.json()).toMatchObject({
      code: 'authentication_required',
    });
    const connection = await app.request('/v1/providers/test-main/test', {
      method: 'POST',
    });
    expect(connection.status).toBe(400);
    expect(await connection.json()).toMatchObject({
      code: 'authentication_required',
    });
  });

  it('does not hide discovery failures after known-model mutations', async () => {
    const app = makeApp({
      addKnownModel: vi.fn(async () => ({
        ok: true as const,
        code: 'available' as const,
        value: undefined,
      })),
      listModels: vi.fn(async () => ({
        ok: false as const,
        code: 'discovery_failed' as const,
        message: 'Discovery unavailable',
      })),
    });
    const response = await app.request('/v1/providers/test-main/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelId: 'manual', displayName: 'Manual' }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'discovery_failed' });
  });

  it('returns measured connectivity results', async () => {
    const app = makeApp({
      testConnection: vi.fn(async () => ({
        ok: true as const,
        code: 'available' as const,
        value: { latencyMs: 12, target: 'https://example.test' },
      })),
    });
    const response = await app.request('/v1/providers/test-main/test', {
      method: 'POST',
    });
    expect(await response.json()).toEqual({
      latencyMs: 12,
      target: 'https://example.test',
    });
  });
});
