import type { OpenAPIHono } from '@hono/zod-openapi';
import { describe, expect, it, vi } from 'vitest';

import type { ModuleLogger } from '@stagewise/logger';

import type { Config, KlexConfig, ModelDefinition } from '@/config';
import { ConfigValidationError } from '@/config';

import {
  createEndpoint,
  createEndpointRoute,
  createKnownModel,
  createKnownModelRoute,
  createProvider,
  createProviderRoute,
  deleteEndpoint,
  deleteEndpointRoute,
  deleteKnownModel,
  deleteKnownModelRoute,
  deleteProvider,
  deleteProviderRoute,
  getEndpoints,
  getEndpointsRoute,
  getKnownModels,
  getKnownModelsRoute,
  getProviders,
  getProvidersRoute,
  type ProviderRouteDependencies,
  updateEndpoint,
  updateEndpointRoute,
  updateKnownModel,
  updateKnownModelRoute,
  updateProvider,
  updateProviderRoute,
} from './providers';
import { setupTestApp } from './test-utils';

const logger = {
  error: () => undefined,
} as unknown as ModuleLogger;

const baseConfig: KlexConfig = {
  providers: {
    'my-openai': {
      preset: 'openai',
      auth: { apiKey: 'sk-test' },
      knownModels: {
        'gpt-4o': {
          displayName: 'GPT-4o',
          contextSize: 128_000,
          inputCapabilities: {
            image: { mediaTypes: ['image/png'], maxBytes: 5_000_000 },
          },
        },
      },
    },
    local: {
      endpoints: {
        chat: {
          url: 'http://localhost:11434/v1',
          format: 'chat-completions',
          auth: {},
          knownModels: {
            'model:8b': { displayName: 'Model 8B', contextSize: 32_000 },
          },
        },
        api: {
          url: 'http://localhost:8080/v1',
          format: 'open-responses',
          auth: { apiKey: 'local-key' },
        },
      },
    },
  },
  modelSelection: {
    chat: ['my-openai:gpt-4o'],
    compaction: [],
    memory: [],
    routing: [],
  },
  mcpServers: {},
};

function makeDeps(config: Partial<Config> = {}): ProviderRouteDependencies {
  return {
    config: {
      get: () => baseConfig,
      mutate: vi.fn(async (fn: (cfg: KlexConfig) => KlexConfig) =>
        fn(baseConfig),
      ),
      addProvider: vi.fn(async () => baseConfig),
      updateProvider: vi.fn(async () => baseConfig),
      removeProvider: vi.fn(async () => baseConfig),
      addEndpoint: vi.fn(async () => baseConfig),
      updateEndpoint: vi.fn(async () => baseConfig),
      removeEndpoint: vi.fn(async () => baseConfig),
      addKnownModel: vi.fn(async () => baseConfig),
      updateKnownModel: vi.fn(async () => baseConfig),
      removeKnownModel: vi.fn(async () => baseConfig),
      ...config,
    } as unknown as Config,
    logger,
  };
}

function createApp(deps: ProviderRouteDependencies): OpenAPIHono {
  return setupTestApp((app) => {
    app.openapi(getProvidersRoute, getProviders(deps));
    app.openapi(createProviderRoute, createProvider(deps));
    app.openapi(updateProviderRoute, updateProvider(deps));
    app.openapi(deleteProviderRoute, deleteProvider(deps));
    app.openapi(getEndpointsRoute, getEndpoints(deps));
    app.openapi(createEndpointRoute, createEndpoint(deps));
    app.openapi(updateEndpointRoute, updateEndpoint(deps));
    app.openapi(deleteEndpointRoute, deleteEndpoint(deps));
    app.openapi(getKnownModelsRoute, getKnownModels(deps));
    app.openapi(createKnownModelRoute, createKnownModel(deps));
    app.openapi(updateKnownModelRoute, updateKnownModel(deps));
    app.openapi(deleteKnownModelRoute, deleteKnownModel(deps));
  });
}

// ---------------------------------------------------------------------------
// GET /v1/providers
// ---------------------------------------------------------------------------

describe('GET /v1/providers — list providers', () => {
  it('returns all configured providers', async () => {
    const app = createApp(makeDeps());
    const response = await app.request('/v1/providers');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { providers: unknown[] };
    expect(body.providers).toHaveLength(2);
  });

  it('returns empty list when no providers configured', async () => {
    const app = createApp(
      makeDeps({
        get: () => ({
          ...baseConfig,
          providers: {},
        }),
      }),
    );
    const response = await app.request('/v1/providers');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ providers: [] });
  });

  it('redacts API keys in preset provider responses', async () => {
    const app = createApp(makeDeps());
    const response = await app.request('/v1/providers');
    const body = (await response.json()) as {
      providers: Array<Record<string, unknown>>;
    };
    const preset = body.providers.find((p) => 'preset' in p);
    expect(preset).toBeDefined();
    expect((preset!.auth as Record<string, unknown>).apiKey).toBe('[REDACTED]');
  });

  it('redacts API keys in manual provider endpoint responses', async () => {
    const app = createApp(makeDeps());
    const response = await app.request('/v1/providers');
    const body = (await response.json()) as {
      providers: Array<Record<string, unknown>>;
    };
    const manual = body.providers.find((p) => 'endpoints' in p);
    expect(manual).toBeDefined();
    const endpoints = manual!.endpoints as Record<
      string,
      Record<string, unknown>
    >;
    const api = endpoints.api as { auth: { apiKey?: string } } | undefined;
    expect(api).toBeDefined();
    expect(api!.auth.apiKey).toBe('[REDACTED]');
  });

  it('does not include knownModels in endpoint objects', async () => {
    const app = createApp(makeDeps());
    const response = await app.request('/v1/providers');
    const body = (await response.json()) as {
      providers: Array<Record<string, unknown>>;
    };
    const manual = body.providers.find((p) => 'endpoints' in p);
    expect(manual).toBeDefined();
    const endpoints = manual!.endpoints as Record<
      string,
      Record<string, unknown>
    >;
    const chat = endpoints.chat;
    expect(chat).toBeDefined();
    expect(chat).not.toHaveProperty('knownModels');
    expect(Object.keys(chat!)).toEqual(['url', 'format', 'auth']);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/providers
// ---------------------------------------------------------------------------

describe('POST /v1/providers — create provider', () => {
  it('rejects invalid JSON body with 400', async () => {
    const app = createApp(makeDeps());
    const response = await app.request('/v1/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{invalid',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Malformed JSON in request body',
    });
  });

  it('rejects body without a name field with 400', async () => {
    const app = createApp(makeDeps());
    const response = await app.request('/v1/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ preset: 'openai', auth: { apiKey: 'sk' } }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });

  it('accepts a valid preset provider and returns 201', async () => {
    const addProviderFn = vi.fn(async () => baseConfig);
    const app = createApp(makeDeps({ addProvider: addProviderFn }));
    const response = await app.request('/v1/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'new-provider',
        preset: 'anthropic',
        auth: { apiKey: 'sk-new' },
      }),
    });
    expect(response.status).toBe(201);
    expect(addProviderFn).toHaveBeenCalledWith('new-provider', {
      preset: 'anthropic',
      auth: { apiKey: 'sk-new' },
    });
  });

  it('accepts a valid manual provider and returns 201', async () => {
    const addProviderFn = vi.fn(async () => baseConfig);
    const app = createApp(makeDeps({ addProvider: addProviderFn }));
    const response = await app.request('/v1/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'custom',
        endpoints: {
          main: {
            url: 'http://localhost:3000/v1',
            format: 'chat-completions',
            auth: { apiKey: 'key' },
          },
        },
      }),
    });
    expect(response.status).toBe(201);
    expect(addProviderFn).toHaveBeenCalledWith('custom', {
      endpoints: {
        main: {
          url: 'http://localhost:3000/v1',
          format: 'chat-completions',
          auth: { apiKey: 'key' },
        },
      },
    });
  });

  it('maps ConfigValidationError to 409', async () => {
    const app = createApp(
      makeDeps({
        addProvider: vi.fn(async () => {
          throw new ConfigValidationError("Provider 'exists' already exists", {
            code: 'already_exists',
          });
        }),
      }),
    );
    const response = await app.request('/v1/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'exists',
        preset: 'openai',
        auth: { apiKey: 'sk' },
      }),
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('already exists');
  });

  it('maps unexpected errors to 500', async () => {
    const app = createApp(
      makeDeps({
        addProvider: vi.fn(async () => {
          throw new Error('disk full');
        }),
      }),
    );
    const response = await app.request('/v1/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'new',
        preset: 'openai',
        auth: { apiKey: 'sk' },
      }),
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: 'Failed to create provider',
    });
  });
});

// ---------------------------------------------------------------------------
// PATCH /v1/providers/:name
// ---------------------------------------------------------------------------

describe('PATCH /v1/providers/:name — update provider', () => {
  it('rejects invalid JSON body with 400', async () => {
    const app = createApp(makeDeps());
    const response = await app.request('/v1/providers/local', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: '{invalid',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Malformed JSON in request body',
    });
  });

  it('updates preset provider auth and returns 200', async () => {
    const mutateFn = vi.fn(async (fn: (cfg: KlexConfig) => KlexConfig) =>
      fn(baseConfig),
    );
    const app = createApp(makeDeps({ mutate: mutateFn }));
    const response = await app.request('/v1/providers/my-openai', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ auth: { apiKey: 'sk-updated' } }),
    });
    expect(response.status).toBe(200);
    expect(mutateFn).toHaveBeenCalled();
    const result = (await mutateFn.mock.results[0]!.value) as KlexConfig;
    const provider = result.providers['my-openai']! as {
      preset: string;
      auth: { apiKey?: string };
      knownModels?: Record<string, unknown>;
    };
    expect(provider.preset).toBe('openai');
    expect(provider.auth?.apiKey).toBe('sk-updated');
    expect(provider.knownModels).toEqual({
      'gpt-4o': {
        displayName: 'GPT-4o',
        contextSize: 128_000,
        inputCapabilities: {
          image: { mediaTypes: ['image/png'], maxBytes: 5_000_000 },
        },
      },
    });
  });

  it('merges new endpoints with existing ones on manual provider', async () => {
    const mutateFn = vi.fn(async (fn: (cfg: KlexConfig) => KlexConfig) =>
      fn(baseConfig),
    );
    const app = createApp(makeDeps({ mutate: mutateFn }));
    const response = await app.request('/v1/providers/local', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        endpoints: {
          new: {
            url: 'http://localhost:9999/v1',
            format: 'messages',
            auth: {},
          },
        },
      }),
    });
    expect(response.status).toBe(200);
    const result = (await mutateFn.mock.results[0]!.value) as KlexConfig;
    const provider = result.providers.local! as {
      endpoints: Record<string, unknown>;
    };
    expect(provider.endpoints).toHaveProperty('chat');
    expect(provider.endpoints).toHaveProperty('api');
    expect(provider.endpoints).toHaveProperty('new');
  });

  it('preserves knownModels when patching an existing endpoint', async () => {
    const mutateFn = vi.fn(async (fn: (cfg: KlexConfig) => KlexConfig) =>
      fn(baseConfig),
    );
    const app = createApp(makeDeps({ mutate: mutateFn }));
    const response = await app.request('/v1/providers/local', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        endpoints: {
          chat: {
            url: 'http://localhost:9999/v1',
            format: 'messages',
            auth: {},
          },
        },
      }),
    });
    expect(response.status).toBe(200);
    const result = (await mutateFn.mock.results[0]!.value) as KlexConfig;
    const provider = result.providers.local! as {
      endpoints: Record<string, Record<string, unknown>>;
    };
    const chat = provider.endpoints.chat!;
    expect(chat.url).toBe('http://localhost:9999/v1');
    expect(chat.format).toBe('messages');
    expect(chat.knownModels).toEqual({
      'model:8b': { displayName: 'Model 8B', contextSize: 32_000 },
    });
  });

  it('returns 404 for unknown provider', async () => {
    const app = createApp(makeDeps());
    const response = await app.request('/v1/providers/nonexistent', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ auth: { apiKey: 'sk' } }),
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('not found');
  });

  it('maps ConfigValidationError to 404', async () => {
    const app = createApp(makeDeps());
    const response = await app.request('/v1/providers/missing', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ auth: { apiKey: 'sk' } }),
    });
    expect(response.status).toBe(404);
  });

  it('maps unexpected errors to 500', async () => {
    const app = createApp(
      makeDeps({
        mutate: vi.fn(async () => {
          throw new Error('disk full');
        }),
      }),
    );
    const response = await app.request('/v1/providers/local', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        endpoints: {
          chat: {
            url: 'http://localhost:11434/v1',
            format: 'chat-completions',
            auth: {},
          },
        },
      }),
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: 'Failed to update provider',
    });
  });

  it('rejects endpoints on preset provider with 400', async () => {
    const app = createApp(makeDeps());
    const response = await app.request('/v1/providers/my-openai', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        endpoints: {
          main: {
            url: 'http://localhost:3000/v1',
            format: 'chat-completions',
            auth: {},
          },
        },
      }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('preset');
  });

  it('rejects preset field on manual provider with 400', async () => {
    const app = createApp(makeDeps());
    const response = await app.request('/v1/providers/local', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ preset: 'openai' }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('manual');
  });

  it('rejects auth field on manual provider with 400', async () => {
    const app = createApp(makeDeps());
    const response = await app.request('/v1/providers/local', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ auth: { apiKey: 'sk' } }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('manual');
  });
});

// ---------------------------------------------------------------------------
// DELETE /v1/providers/:name
// ---------------------------------------------------------------------------

describe('DELETE /v1/providers/:name — delete provider', () => {
  it('deletes a provider and returns updated list', async () => {
    const removeProviderFn = vi.fn(async () => baseConfig);
    const app = createApp(makeDeps({ removeProvider: removeProviderFn }));
    const response = await app.request('/v1/providers/local', {
      method: 'DELETE',
    });
    expect(response.status).toBe(200);
    expect(removeProviderFn).toHaveBeenCalledWith('local');
    const body = (await response.json()) as { providers: unknown[] };
    expect(body.providers).toBeDefined();
  });

  it('maps ConfigValidationError to 404', async () => {
    const app = createApp(
      makeDeps({
        removeProvider: vi.fn(async () => {
          throw new ConfigValidationError("Provider 'missing' not found", {
            code: 'not_found',
          });
        }),
      }),
    );
    const response = await app.request('/v1/providers/missing', {
      method: 'DELETE',
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('not found');
  });

  it('returns 409 when provider is referenced by model selection', async () => {
    const app = createApp(
      makeDeps({
        removeProvider: vi.fn(async () => {
          throw new ConfigValidationError(
            "Cannot delete provider 'my-openai' because it is still referenced by model selection 'chat'",
            { code: 'referential_integrity' },
          );
        }),
      }),
    );
    const response = await app.request('/v1/providers/my-openai', {
      method: 'DELETE',
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('referenced by model selection');
  });

  it('maps unexpected errors to 500', async () => {
    const app = createApp(
      makeDeps({
        removeProvider: vi.fn(async () => {
          throw new Error('disk full');
        }),
      }),
    );
    const response = await app.request('/v1/providers/local', {
      method: 'DELETE',
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: 'Failed to delete provider',
    });
  });
});

// ---------------------------------------------------------------------------
// GET /v1/providers/:name/endpoints
// ---------------------------------------------------------------------------

describe('GET /v1/providers/:name/endpoints — list endpoints', () => {
  it('returns endpoints for a manual provider', async () => {
    const app = createApp(makeDeps());
    const response = await app.request('/v1/providers/local/endpoints');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { endpoints: unknown[] };
    expect(body.endpoints).toHaveLength(2);
  });

  it('returns 400 for a preset provider', async () => {
    const app = createApp(makeDeps());
    const response = await app.request('/v1/providers/my-openai/endpoints');
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('preset');
  });

  it('returns 404 for unknown provider', async () => {
    const app = createApp(makeDeps());
    const response = await app.request('/v1/providers/nonexistent/endpoints');
    expect(response.status).toBe(404);
  });

  it('redacts API keys in endpoint responses', async () => {
    const app = createApp(makeDeps());
    const response = await app.request('/v1/providers/local/endpoints');
    const body = (await response.json()) as {
      endpoints: Array<Record<string, unknown>>;
    };
    const api = body.endpoints.find((e) => e.name === 'api');
    expect(api).toBeDefined();
    expect((api!.auth as Record<string, unknown>).apiKey).toBe('[REDACTED]');
  });
});

// ---------------------------------------------------------------------------
// POST /v1/providers/:name/endpoints
// ---------------------------------------------------------------------------

describe('POST /v1/providers/:name/endpoints — create endpoint', () => {
  it('creates an endpoint on a manual provider and returns 201', async () => {
    const addEndpointFn = vi.fn(async () => baseConfig);
    const app = createApp(makeDeps({ addEndpoint: addEndpointFn }));
    const response = await app.request('/v1/providers/local/endpoints', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'new-ep',
        url: 'http://localhost:7000/v1',
        format: 'open-responses',
        auth: { apiKey: 'key' },
      }),
    });
    expect(response.status).toBe(201);
    expect(addEndpointFn).toHaveBeenCalledWith('local', 'new-ep', {
      url: 'http://localhost:7000/v1',
      format: 'open-responses',
      auth: { apiKey: 'key' },
    });
  });

  it('returns 400 for a preset provider', async () => {
    const app = createApp(
      makeDeps({
        addEndpoint: vi.fn(async () => {
          throw new ConfigValidationError(
            "Cannot add endpoints to preset provider 'my-openai'",
            { code: 'type_mismatch' },
          );
        }),
      }),
    );
    const response = await app.request('/v1/providers/my-openai/endpoints', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'ep',
        url: 'http://localhost:7000/v1',
        format: 'open-responses',
        auth: {},
      }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('preset');
  });

  it('returns 404 for unknown provider', async () => {
    const app = createApp(
      makeDeps({
        addEndpoint: vi.fn(async () => {
          throw new ConfigValidationError("Provider 'nonexistent' not found", {
            code: 'not_found',
          });
        }),
      }),
    );
    const response = await app.request('/v1/providers/nonexistent/endpoints', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'ep',
        url: 'http://localhost:7000/v1',
        format: 'open-responses',
        auth: {},
      }),
    });
    expect(response.status).toBe(404);
  });

  it('returns 409 for duplicate endpoint name', async () => {
    const app = createApp(
      makeDeps({
        addEndpoint: vi.fn(async () => {
          throw new ConfigValidationError(
            "Endpoint 'chat' already exists in provider 'local'",
            { code: 'already_exists' },
          );
        }),
      }),
    );
    const response = await app.request('/v1/providers/local/endpoints', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'chat',
        url: 'http://localhost:7000/v1',
        format: 'open-responses',
        auth: {},
      }),
    });
    expect(response.status).toBe(409);
  });

  it('rejects invalid JSON body with 400', async () => {
    const app = createApp(makeDeps());
    const response = await app.request('/v1/providers/local/endpoints', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{invalid',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Malformed JSON in request body',
    });
  });
});

// ---------------------------------------------------------------------------
// PATCH /v1/providers/:name/endpoints/:endpointName
// ---------------------------------------------------------------------------

describe('PATCH /v1/providers/:name/endpoints/:endpointName — update endpoint', () => {
  it('updates an endpoint and returns 200', async () => {
    const mutateFn = vi.fn(async (fn: (cfg: KlexConfig) => KlexConfig) =>
      fn(baseConfig),
    );
    const app = createApp(makeDeps({ mutate: mutateFn }));
    const response = await app.request('/v1/providers/local/endpoints/chat', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'http://localhost:9999/v1' }),
    });
    expect(response.status).toBe(200);
    expect(mutateFn).toHaveBeenCalled();
    const result = (await mutateFn.mock.results[0]!.value) as KlexConfig;
    const provider = result.providers.local! as {
      endpoints: Record<string, { url: string; format: string }>;
    };
    const ep = provider.endpoints.chat!;
    expect(ep.url).toBe('http://localhost:9999/v1');
    expect(ep.format).toBe('chat-completions');
  });

  it('preserves knownModels when patching an endpoint', async () => {
    const mutateFn = vi.fn(async (fn: (cfg: KlexConfig) => KlexConfig) =>
      fn(baseConfig),
    );
    const app = createApp(makeDeps({ mutate: mutateFn }));
    const response = await app.request('/v1/providers/local/endpoints/chat', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'http://localhost:9999/v1' }),
    });
    expect(response.status).toBe(200);
    const result = (await mutateFn.mock.results[0]!.value) as KlexConfig;
    const provider = result.providers.local! as {
      endpoints: Record<string, { knownModels?: Record<string, unknown> }>;
    };
    const ep = provider.endpoints.chat!;
    expect(ep.knownModels).toBeDefined();
    expect(ep.knownModels).toHaveProperty('model:8b');
  });

  it('merges auth headers when patching only auth', async () => {
    const configWithHeaders: KlexConfig = {
      providers: {
        local: {
          endpoints: {
            chat: {
              url: 'http://localhost:11434/v1',
              format: 'chat-completions',
              auth: {
                apiKey: 'original-key',
                headers: { 'X-Existing': 'old-value' },
              },
            },
          },
        },
      },
      modelSelection: { chat: [], compaction: [], memory: [], routing: [] },
      mcpServers: {},
    };
    const mutateFn = vi.fn(async (fn: (cfg: KlexConfig) => KlexConfig) =>
      fn(configWithHeaders),
    );
    const app = createApp(
      makeDeps({
        mutate: mutateFn,
        get: () => configWithHeaders,
      }),
    );
    const response = await app.request('/v1/providers/local/endpoints/chat', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        auth: { headers: { 'X-New': 'new-value' } },
      }),
    });
    expect(response.status).toBe(200);
    const result = (await mutateFn.mock.results[0]!.value) as KlexConfig;
    const provider = result.providers.local! as {
      endpoints: Record<
        string,
        { auth: { apiKey?: string; headers?: Record<string, string> } }
      >;
    };
    const ep = provider.endpoints.chat!;
    // Preserves existing apiKey when only headers are patched
    expect(ep.auth.apiKey).toBe('original-key');
    // Merges old and new headers
    expect(ep.auth.headers).toEqual({
      'X-Existing': 'old-value',
      'X-New': 'new-value',
    });
  });

  it('returns 404 for unknown endpoint', async () => {
    const app = createApp(makeDeps());
    const response = await app.request(
      '/v1/providers/local/endpoints/nonexistent',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'http://localhost:9999/v1' }),
      },
    );
    expect(response.status).toBe(404);
  });

  it('returns 404 for unknown provider', async () => {
    const app = createApp(makeDeps());
    const response = await app.request(
      '/v1/providers/nonexistent/endpoints/chat',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'http://localhost:9999/v1' }),
      },
    );
    expect(response.status).toBe(404);
  });

  it('returns 400 for preset provider', async () => {
    const app = createApp(makeDeps());
    const response = await app.request(
      '/v1/providers/my-openai/endpoints/anything',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'http://localhost:9999/v1' }),
      },
    );
    expect(response.status).toBe(400);
  });

  it('maps unexpected errors to 500', async () => {
    const app = createApp(
      makeDeps({
        mutate: vi.fn(async () => {
          throw new Error('disk full');
        }),
      }),
    );
    const response = await app.request('/v1/providers/local/endpoints/chat', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'http://localhost:9999/v1' }),
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: 'Failed to update endpoint',
    });
  });
});

// ---------------------------------------------------------------------------
// DELETE /v1/providers/:name/endpoints/:endpointName
// ---------------------------------------------------------------------------

describe('DELETE /v1/providers/:name/endpoints/:endpointName — delete endpoint', () => {
  it('deletes an endpoint and returns 200', async () => {
    const removeEndpointFn = vi.fn(async () => baseConfig);
    const app = createApp(makeDeps({ removeEndpoint: removeEndpointFn }));
    const response = await app.request('/v1/providers/local/endpoints/api', {
      method: 'DELETE',
    });
    expect(response.status).toBe(200);
    expect(removeEndpointFn).toHaveBeenCalledWith('local', 'api');
  });

  it('maps ConfigValidationError to 404', async () => {
    const app = createApp(
      makeDeps({
        removeEndpoint: vi.fn(async () => {
          throw new ConfigValidationError(
            "Endpoint 'missing' not found in provider 'local'",
            { code: 'not_found' },
          );
        }),
      }),
    );
    const response = await app.request(
      '/v1/providers/local/endpoints/missing',
      {
        method: 'DELETE',
      },
    );
    expect(response.status).toBe(404);
  });

  it('returns 400 for preset provider', async () => {
    const app = createApp(
      makeDeps({
        removeEndpoint: vi.fn(async () => {
          throw new ConfigValidationError(
            "Cannot remove endpoints from preset provider 'my-openai'",
            { code: 'type_mismatch' },
          );
        }),
      }),
    );
    const response = await app.request(
      '/v1/providers/my-openai/endpoints/anything',
      {
        method: 'DELETE',
      },
    );
    expect(response.status).toBe(400);
  });

  it('returns 409 when endpoint is referenced by model selection', async () => {
    const app = createApp(
      makeDeps({
        removeEndpoint: vi.fn(async () => {
          throw new ConfigValidationError(
            "Cannot delete endpoint 'local:chat' because it is still referenced by model selection 'chat'",
            { code: 'referential_integrity' },
          );
        }),
      }),
    );
    const response = await app.request('/v1/providers/local/endpoints/chat', {
      method: 'DELETE',
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('referenced by model selection');
  });

  it('maps unexpected errors to 500', async () => {
    const app = createApp(
      makeDeps({
        removeEndpoint: vi.fn(async () => {
          throw new Error('disk full');
        }),
      }),
    );
    const response = await app.request('/v1/providers/local/endpoints/api', {
      method: 'DELETE',
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: 'Failed to delete endpoint',
    });
  });
});

// ---------------------------------------------------------------------------
// GET /v1/providers/:name/known-models
// ---------------------------------------------------------------------------

describe('GET /v1/providers/:name/known-models — list known models', () => {
  it('returns preset provider models without endpointName', async () => {
    const app = createApp(makeDeps());
    const response = await app.request('/v1/providers/my-openai/known-models');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { models: unknown[] };
    expect(body.models).toHaveLength(1);
    expect(body.models[0]).toMatchObject({ modelId: 'gpt-4o' });
  });

  it('includes inputCapabilities in known-models response', async () => {
    const app = createApp(makeDeps());
    const response = await app.request('/v1/providers/my-openai/known-models');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      models: Array<Record<string, unknown>>;
    };
    expect(body.models[0]).toMatchObject({
      modelId: 'gpt-4o',
      inputCapabilities: {
        image: { mediaTypes: ['image/png'], maxBytes: 5_000_000 },
      },
    });
  });

  it('returns manual provider models across all endpoints', async () => {
    const app = createApp(makeDeps());
    const response = await app.request('/v1/providers/local/known-models');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { models: unknown[] };
    expect(body.models).toHaveLength(1);
    expect(body.models[0]).toMatchObject({
      modelId: 'model:8b',
      endpointName: 'chat',
    });
  });

  it('filters manual provider models by endpointName query param', async () => {
    const app = createApp(makeDeps());
    const response = await app.request(
      '/v1/providers/local/known-models?endpointName=api',
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { models: unknown[] };
    expect(body.models).toEqual([]);
  });

  it('returns 404 for unknown provider', async () => {
    const app = createApp(makeDeps());
    const response = await app.request(
      '/v1/providers/nonexistent/known-models',
    );
    expect(response.status).toBe(404);
  });

  it('returns 404 for unknown endpoint query param on manual provider', async () => {
    const app = createApp(makeDeps());
    const response = await app.request(
      '/v1/providers/local/known-models?endpointName=nonexistent',
    );
    expect(response.status).toBe(404);
  });

  it('returns 400 when endpointName is provided for a preset provider', async () => {
    const app = createApp(makeDeps());
    const response = await app.request(
      '/v1/providers/my-openai/known-models?endpointName=default',
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Preset');
  });
});

// ---------------------------------------------------------------------------
// POST /v1/providers/:name/known-models
// ---------------------------------------------------------------------------

describe('POST /v1/providers/:name/known-models — add known model', () => {
  it('adds a model to a preset provider without endpointName', async () => {
    const addKnownModelFn = vi.fn(async () => baseConfig);
    const app = createApp(makeDeps({ addKnownModel: addKnownModelFn }));
    const response = await app.request('/v1/providers/my-openai/known-models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        modelId: 'gpt-4o-mini',
        displayName: 'GPT-4o Mini',
        contextSize: 128_000,
      }),
    });
    expect(response.status).toBe(201);
    expect(addKnownModelFn).toHaveBeenCalledWith(
      'my-openai',
      'gpt-4o-mini',
      { displayName: 'GPT-4o Mini', contextSize: 128_000 },
      undefined,
    );
  });

  it('adds a model to a manual provider with endpointName', async () => {
    const addKnownModelFn = vi.fn(async () => baseConfig);
    const app = createApp(makeDeps({ addKnownModel: addKnownModelFn }));
    const response = await app.request('/v1/providers/local/known-models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        modelId: 'llama3',
        endpointName: 'chat',
        contextSize: 8_000,
      }),
    });
    expect(response.status).toBe(201);
    expect(addKnownModelFn).toHaveBeenCalledWith(
      'local',
      'llama3',
      {
        contextSize: 8_000,
      },
      'chat',
    );
  });

  it('rejects endpointName on preset provider with 400', async () => {
    const addKnownModelFn = vi.fn(async () => {
      throw new ConfigValidationError(
        `Preset provider 'my-openai' does not support endpoint-scoped known models`,
        { code: 'type_mismatch' },
      );
    });
    const app = createApp(makeDeps({ addKnownModel: addKnownModelFn }));
    const response = await app.request('/v1/providers/my-openai/known-models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        modelId: 'gpt-4o',
        endpointName: 'default',
        displayName: 'Test',
      }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Preset');
  });

  it('rejects missing endpointName on manual provider with 400', async () => {
    const addKnownModelFn = vi.fn(async () => {
      throw new ConfigValidationError(
        `Manual provider 'local' requires an endpoint name for known models`,
        { code: 'type_mismatch' },
      );
    });
    const app = createApp(makeDeps({ addKnownModel: addKnownModelFn }));
    const response = await app.request('/v1/providers/local/known-models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelId: 'llama3', displayName: 'Test' }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('endpoint name');
  });

  it('returns 404 for unknown endpoint on manual provider', async () => {
    const addKnownModelFn = vi.fn(async () => {
      throw new ConfigValidationError(
        `Endpoint 'nonexistent' not found in provider 'local'`,
        { code: 'not_found' },
      );
    });
    const app = createApp(makeDeps({ addKnownModel: addKnownModelFn }));
    const response = await app.request('/v1/providers/local/known-models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        modelId: 'llama3',
        endpointName: 'nonexistent',
        displayName: 'Test',
      }),
    });
    expect(response.status).toBe(404);
  });

  it('returns 404 for unknown provider', async () => {
    const addKnownModelFn = vi.fn(async () => {
      throw new ConfigValidationError(`Provider 'nonexistent' not found`, {
        code: 'not_found',
      });
    });
    const app = createApp(makeDeps({ addKnownModel: addKnownModelFn }));
    const response = await app.request(
      '/v1/providers/nonexistent/known-models',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ modelId: 'gpt-4o', displayName: 'Test' }),
      },
    );
    expect(response.status).toBe(404);
  });

  it('returns 409 for duplicate modelId', async () => {
    const app = createApp(
      makeDeps({
        addKnownModel: vi.fn(async () => {
          throw new ConfigValidationError(
            "Model 'gpt-4o' already exists in provider 'my-openai'",
            { code: 'already_exists' },
          );
        }),
      }),
    );
    const response = await app.request('/v1/providers/my-openai/known-models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelId: 'gpt-4o', displayName: 'Test' }),
    });
    expect(response.status).toBe(409);
  });

  it('rejects invalid JSON body with 400', async () => {
    const app = createApp(makeDeps());
    const response = await app.request('/v1/providers/local/known-models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{invalid',
    });
    expect(response.status).toBe(400);
  });

  it('rejects body with neither displayName, contextSize, nor inputCapabilities with 400', async () => {
    const app = createApp(makeDeps());
    const response = await app.request('/v1/providers/my-openai/known-models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelId: 'gpt-4o' }),
    });
    expect(response.status).toBe(400);
  });

  it('creates a model with inputCapabilities on a preset provider', async () => {
    const addKnownModelFn = vi.fn(async () => baseConfig);
    const app = createApp(makeDeps({ addKnownModel: addKnownModelFn }));
    const response = await app.request('/v1/providers/my-openai/known-models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        modelId: 'gpt-4o-vision',
        inputCapabilities: {
          image: {
            mediaTypes: ['image/png', 'image/jpeg'],
            maxBytes: 10_000_000,
          },
          audio: { mediaTypes: ['audio/wav'], maxBytes: 20_000_000 },
        },
      }),
    });
    expect(response.status).toBe(201);
    expect(addKnownModelFn).toHaveBeenCalledWith(
      'my-openai',
      'gpt-4o-vision',
      {
        inputCapabilities: {
          image: {
            mediaTypes: ['image/png', 'image/jpeg'],
            maxBytes: 10_000_000,
          },
          audio: { mediaTypes: ['audio/wav'], maxBytes: 20_000_000 },
        },
      },
      undefined,
    );
  });

  it('creates a model with only inputCapabilities (no displayName or contextSize)', async () => {
    const addKnownModelFn = vi.fn(async () => baseConfig);
    const app = createApp(makeDeps({ addKnownModel: addKnownModelFn }));
    const response = await app.request('/v1/providers/local/known-models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        modelId: 'vision-model',
        endpointName: 'chat',
        inputCapabilities: {
          image: { mediaTypes: ['image/webp'], maxBytes: 8_000_000 },
        },
      }),
    });
    expect(response.status).toBe(201);
    expect(addKnownModelFn).toHaveBeenCalledWith(
      'local',
      'vision-model',
      {
        inputCapabilities: {
          image: { mediaTypes: ['image/webp'], maxBytes: 8_000_000 },
        },
      },
      'chat',
    );
  });
});

// ---------------------------------------------------------------------------
// PATCH /v1/providers/:name/known-models/:modelId
// ---------------------------------------------------------------------------

describe('PATCH /v1/providers/:name/known-models/:modelId — update known model', () => {
  it('updates a preset provider model without endpointName', async () => {
    const mutateFn = vi.fn(async (fn: (cfg: KlexConfig) => KlexConfig) =>
      fn(baseConfig),
    );
    const app = createApp(makeDeps({ mutate: mutateFn }));
    const response = await app.request(
      '/v1/providers/my-openai/known-models/gpt-4o',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: 'GPT-4o Updated' }),
      },
    );
    expect(response.status).toBe(200);
    expect(mutateFn).toHaveBeenCalled();
    const result = (await mutateFn.mock.results[0]!.value) as KlexConfig;
    const provider = result.providers['my-openai']! as {
      knownModels?: Record<
        string,
        { displayName?: string; contextSize?: number }
      >;
    };
    expect(provider.knownModels?.['gpt-4o']).toEqual({
      displayName: 'GPT-4o Updated',
      contextSize: 128_000,
      inputCapabilities: {
        image: { mediaTypes: ['image/png'], maxBytes: 5_000_000 },
      },
    });
  });

  it('updates a manual provider model with endpointName query param', async () => {
    const mutateFn = vi.fn(async (fn: (cfg: KlexConfig) => KlexConfig) =>
      fn(baseConfig),
    );
    const app = createApp(makeDeps({ mutate: mutateFn }));
    const response = await app.request(
      '/v1/providers/local/known-models/model:8b?endpointName=chat',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contextSize: 64_000 }),
      },
    );
    expect(response.status).toBe(200);
    expect(mutateFn).toHaveBeenCalled();
    const result = (await mutateFn.mock.results[0]!.value) as KlexConfig;
    const provider = result.providers.local! as {
      endpoints: Record<
        string,
        {
          knownModels?: Record<
            string,
            { displayName?: string; contextSize?: number }
          >;
        }
      >;
    };
    const ep = provider.endpoints.chat!;
    expect(ep.knownModels?.['model:8b']).toEqual({
      displayName: 'Model 8B',
      contextSize: 64_000,
    });
  });

  it('rejects endpointName query on preset provider with 400', async () => {
    const app = createApp(makeDeps());
    const response = await app.request(
      '/v1/providers/my-openai/known-models/gpt-4o?endpointName=default',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: 'x' }),
      },
    );
    expect(response.status).toBe(400);
  });

  it('rejects missing endpointName query on manual provider with 400', async () => {
    const app = createApp(makeDeps());
    const response = await app.request(
      '/v1/providers/local/known-models/model:8b',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: 'x' }),
      },
    );
    expect(response.status).toBe(400);
  });

  it('returns 404 for unknown model on preset provider', async () => {
    const app = createApp(makeDeps());
    const response = await app.request(
      '/v1/providers/my-openai/known-models/nonexistent',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: 'x' }),
      },
    );
    expect(response.status).toBe(404);
  });

  it('returns 404 for unknown model on manual provider', async () => {
    const app = createApp(makeDeps());
    const response = await app.request(
      '/v1/providers/local/known-models/nonexistent?endpointName=chat',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: 'x' }),
      },
    );
    expect(response.status).toBe(404);
  });

  it('returns 404 for unknown provider', async () => {
    const app = createApp(makeDeps());
    const response = await app.request(
      '/v1/providers/nonexistent/known-models/gpt-4o',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: 'x' }),
      },
    );
    expect(response.status).toBe(404);
  });

  it('updates inputCapabilities while preserving displayName and contextSize', async () => {
    const mutateFn = vi.fn(async (fn: (cfg: KlexConfig) => KlexConfig) =>
      fn(baseConfig),
    );
    const app = createApp(makeDeps({ mutate: mutateFn }));
    const response = await app.request(
      '/v1/providers/my-openai/known-models/gpt-4o',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          inputCapabilities: {
            audio: { mediaTypes: ['audio/mpeg'], maxBytes: 15_000_000 },
          },
        }),
      },
    );
    expect(response.status).toBe(200);
    const result = (await mutateFn.mock.results[0]!.value) as KlexConfig;
    const provider = result.providers['my-openai']! as {
      knownModels?: Record<string, ModelDefinition>;
    };
    expect(provider.knownModels?.['gpt-4o']).toEqual({
      displayName: 'GPT-4o',
      contextSize: 128_000,
      inputCapabilities: {
        audio: { mediaTypes: ['audio/mpeg'], maxBytes: 15_000_000 },
      },
    });
  });

  it('preserves inputCapabilities when patching only displayName', async () => {
    const mutateFn = vi.fn(async (fn: (cfg: KlexConfig) => KlexConfig) =>
      fn(baseConfig),
    );
    const app = createApp(makeDeps({ mutate: mutateFn }));
    const response = await app.request(
      '/v1/providers/my-openai/known-models/gpt-4o',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: 'Renamed' }),
      },
    );
    expect(response.status).toBe(200);
    const result = (await mutateFn.mock.results[0]!.value) as KlexConfig;
    const provider = result.providers['my-openai']! as {
      knownModels?: Record<string, ModelDefinition>;
    };
    expect(provider.knownModels?.['gpt-4o']).toEqual({
      displayName: 'Renamed',
      contextSize: 128_000,
      inputCapabilities: {
        image: { mediaTypes: ['image/png'], maxBytes: 5_000_000 },
      },
    });
  });
});

// ---------------------------------------------------------------------------
// DELETE /v1/providers/:name/known-models/:modelId
// ---------------------------------------------------------------------------

describe('DELETE /v1/providers/:name/known-models/:modelId — delete known model', () => {
  it('deletes a preset provider model without endpointName', async () => {
    const removeKnownModelFn = vi.fn(async () => baseConfig);
    const app = createApp(makeDeps({ removeKnownModel: removeKnownModelFn }));
    const response = await app.request(
      '/v1/providers/my-openai/known-models/gpt-4o',
      { method: 'DELETE' },
    );
    expect(response.status).toBe(200);
    expect(removeKnownModelFn).toHaveBeenCalledWith(
      'my-openai',
      'gpt-4o',
      undefined,
    );
  });

  it('deletes a manual provider model with endpointName query param', async () => {
    const removeKnownModelFn = vi.fn(async () => baseConfig);
    const app = createApp(makeDeps({ removeKnownModel: removeKnownModelFn }));
    const response = await app.request(
      '/v1/providers/local/known-models/model:8b?endpointName=chat',
      { method: 'DELETE' },
    );
    expect(response.status).toBe(200);
    expect(removeKnownModelFn).toHaveBeenCalledWith(
      'local',
      'model:8b',
      'chat',
    );
  });

  it('rejects endpointName query on preset provider with 400', async () => {
    const removeKnownModelFn = vi.fn(async () => {
      throw new ConfigValidationError(
        `Preset provider 'my-openai' does not support endpoint-scoped known models`,
        { code: 'type_mismatch' },
      );
    });
    const app = createApp(makeDeps({ removeKnownModel: removeKnownModelFn }));
    const response = await app.request(
      '/v1/providers/my-openai/known-models/gpt-4o?endpointName=default',
      { method: 'DELETE' },
    );
    expect(response.status).toBe(400);
  });

  it('rejects missing endpointName query on manual provider with 400', async () => {
    const removeKnownModelFn = vi.fn(async () => {
      throw new ConfigValidationError(
        `Manual provider 'local' requires an endpoint name for known models`,
        { code: 'type_mismatch' },
      );
    });
    const app = createApp(makeDeps({ removeKnownModel: removeKnownModelFn }));
    const response = await app.request(
      '/v1/providers/local/known-models/model:8b',
      { method: 'DELETE' },
    );
    expect(response.status).toBe(400);
  });

  it('returns 404 for unknown model', async () => {
    const removeKnownModelFn = vi.fn(async () => {
      throw new ConfigValidationError(
        `Model 'nonexistent' not found in provider 'my-openai'`,
        { code: 'not_found' },
      );
    });
    const app = createApp(makeDeps({ removeKnownModel: removeKnownModelFn }));
    const response = await app.request(
      '/v1/providers/my-openai/known-models/nonexistent',
      { method: 'DELETE' },
    );
    expect(response.status).toBe(404);
  });

  it('returns 404 for unknown provider', async () => {
    const removeKnownModelFn = vi.fn(async () => {
      throw new ConfigValidationError(`Provider 'nonexistent' not found`, {
        code: 'not_found',
      });
    });
    const app = createApp(makeDeps({ removeKnownModel: removeKnownModelFn }));
    const response = await app.request(
      '/v1/providers/nonexistent/known-models/gpt-4o',
      { method: 'DELETE' },
    );
    expect(response.status).toBe(404);
  });
});
