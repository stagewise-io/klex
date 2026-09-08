import type { OpenAPIHono } from '@hono/zod-openapi';
import { describe, expect, it, vi } from 'vitest';

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
    connectivityTest: true,
    customModels: true,
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
    app.openapi(createKnownModelRoute, createKnownModel(deps));
    app.openapi(updateKnownModelRoute, updateKnownModel(deps));
    app.openapi(deleteKnownModelRoute, deleteKnownModel(deps));
  });
}

describe('provider registry routes', () => {
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
      value: [
        {
          modelId: 'vendor:model:latest',
          displayName: 'Latest',
          source: 'merged' as const,
        },
      ],
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
          displayName: 'Latest',
          source: 'merged',
        },
      ],
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
      value: [],
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
