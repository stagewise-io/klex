import type { OpenAPIHono } from '@hono/zod-openapi';
import { describe, expect, it, vi } from 'vitest';

import type { ModuleLogger } from '@stagewise/logger';

import type { Config, KlexConfig } from '@/config';
import type { ProviderRegistry } from '@/provider-registry';

import {
  getAgentIdentity,
  getAgentIdentityRoute,
  getModelSelection,
  getModelSelectionRoute,
  getTelemetry,
  getTelemetryRoute,
  patchAgentIdentity,
  patchAgentIdentityRoute,
  patchModelSelection,
  patchModelSelectionRoute,
  patchTelemetry,
  patchTelemetryRoute,
  type SettingsRouteDependencies,
} from './settings';
import { setupTestApp } from './test-utils';

const logger = { error: () => undefined } as unknown as ModuleLogger;
const reference = { providerId: 'openai-main', modelId: 'org:model:v2' };
const baseConfig: KlexConfig = {
  configVersion: 2,
  episodeFinishIdleTriggerTimeMs: 60_000,
  memoryWriteIntervalMs: 120_000,
  memoryWriteStepInterval: 10,
  officialName: 'Agent',
  providers: {
    'openai-main': {
      type: 'openai',
      settings: { apiKey: '${env:OPENAI_API_KEY}' },
      knownModels: { 'org:model:v2': { displayName: 'Model' } },
    },
  },
  modelSelection: {
    chat: [reference],
    compaction: [],
    memory: [],
    imageVision: [],
    audioListening: [],
    voice: { sts: [], tts: [], stt: [] },
  },
  mcpServers: {},
  timezone: 'UTC',
};

function app(
  config: Config,
  providerRegistry: Partial<ProviderRegistry> = {},
): OpenAPIHono {
  const deps: SettingsRouteDependencies = {
    config,
    logger,
    timezone: 'UTC',
    providerRegistry: providerRegistry as ProviderRegistry,
  };
  return setupTestApp((route) => {
    route.openapi(getAgentIdentityRoute, getAgentIdentity(deps));
    route.openapi(patchAgentIdentityRoute, patchAgentIdentity(deps));
    route.openapi(getModelSelectionRoute, getModelSelection(deps));
    route.openapi(patchModelSelectionRoute, patchModelSelection(deps));
    route.openapi(getTelemetryRoute, getTelemetry(deps));
    route.openapi(patchTelemetryRoute, patchTelemetry(deps));
  });
}

const telemetryInstanceId = '550e8400-e29b-41d4-a716-446655440000';

describe('settings routes', () => {
  it('gets and patches agent identity', async () => {
    const config = {
      get: () => baseConfig,
      mutate: vi.fn(async (fn) => fn(baseConfig)),
    } as unknown as Config;
    const settingsApp = app(config);

    const getResponse = await settingsApp.request('/v1/settings/agent');
    expect(await getResponse.json()).toEqual({ officialName: 'Agent' });
    const patchResponse = await settingsApp.request('/v1/settings/agent', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ officialName: 'Renamed' }),
    });
    expect(patchResponse.status).toBe(200);
    expect(await patchResponse.json()).toEqual({ officialName: 'Renamed' });
  });

  it('gets and patches telemetry settings', async () => {
    const configured = {
      ...baseConfig,
      telemetry: {
        level: 'advanced' as const,
        instanceId: telemetryInstanceId,
      },
    };
    const config = {
      get: () => configured,
      mutate: vi.fn(async (fn) => fn(configured)),
    } as unknown as Config;
    const settingsApp = app(config);

    const getResponse = await settingsApp.request('/v1/settings/telemetry');
    expect(await getResponse.json()).toEqual({
      level: 'advanced',
      instanceId: telemetryInstanceId,
    });
    const patchResponse = await settingsApp.request('/v1/settings/telemetry', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ level: 'basic' }),
    });
    expect(patchResponse.status).toBe(200);
    expect(await patchResponse.json()).toEqual({
      level: 'basic',
      instanceId: telemetryInstanceId,
    });
  });

  it('returns explicit provider/model references without colon parsing', async () => {
    const response = await app({ get: () => baseConfig } as Config).request(
      '/v1/settings/model-selection',
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ chat: [reference] });
  });

  it('updates references whose native model ID contains colons', async () => {
    let current = baseConfig;
    const config = { get: () => current } as unknown as Config;
    const next = {
      providerId: 'openai-main',
      modelId: 'namespace:model:latest',
    };
    const response = await app(config, {
      updateModelSelection: vi.fn(async (patch) => {
        current = {
          ...current,
          modelSelection: { ...current.modelSelection, ...patch },
        };
        return {
          ok: true as const,
          code: 'available' as const,
          value: { selection: current.modelSelection, warnings: [] },
        };
      }),
    }).request('/v1/settings/model-selection', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat: [next] }),
    });
    expect(response.status).toBe(200);
    expect(current.modelSelection.chat).toEqual([next]);
  });

  it('rejects unknown provider instance IDs', async () => {
    const config = { get: () => baseConfig } as unknown as Config;
    const response = await app(config, {
      updateModelSelection: vi.fn(async () => ({
        ok: false as const,
        code: 'referential_integrity' as const,
        message: "Model selection 'chat' references unknown provider 'missing'",
      })),
    }).request('/v1/settings/model-selection', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat: [{ providerId: 'missing', modelId: 'model' }],
      }),
    });
    expect(response.status).toBe(400);
  });
});
