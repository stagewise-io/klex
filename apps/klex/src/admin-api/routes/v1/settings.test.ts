import type { OpenAPIHono } from '@hono/zod-openapi';
import { describe, expect, it, vi } from 'vitest';

import type { ModuleLogger } from '@stagewise/logger';

import type { Config, KlexConfig, ModelSelection } from '@/config';
import { ConfigValidationError } from '@/config';

import {
  getModelSelection,
  getModelSelectionRoute,
  getTelemetry,
  getTelemetryRoute,
  patchModelSelection,
  patchModelSelectionRoute,
  patchTelemetry,
  patchTelemetryRoute,
  type SettingsRouteDependencies,
} from './settings';
import { setupTestApp } from './test-utils';

const logger = {
  error: () => undefined,
} as unknown as ModuleLogger;

const baseSelection: ModelSelection = {
  chat: ['openai:gpt-4o'],
  compaction: ['openai:gpt-4o-mini'],
  memory: ['anthropic:claude-3-haiku'],
  routing: [],
};

const baseConfig: KlexConfig = {
  providers: {
    openai: {
      preset: 'openai',
      auth: { apiKey: 'sk-test' },
      knownModels: {
        'gpt-4o': { displayName: 'GPT-4o', contextSize: 128_000 },
        'gpt-4o-mini': { displayName: 'GPT-4o-mini', contextSize: 128_000 },
      },
    },
    anthropic: {
      preset: 'anthropic',
      auth: { apiKey: 'sk-ant-test' },
      knownModels: {
        'claude-3-haiku': {
          displayName: 'Claude 3 Haiku',
          contextSize: 200_000,
        },
      },
    },
    local: {
      endpoints: {
        default: {
          url: 'http://localhost:8080/v1',
          format: 'openai' as const,
          auth: {},
          knownModels: {
            llama3: { displayName: 'Llama 3', contextSize: 8_000 },
          },
        },
      },
    },
  },
  modelSelection: baseSelection,
  mcpServers: {},
};

function makeDeps(config: Partial<Config> = {}): SettingsRouteDependencies {
  return {
    config: {
      get: () => baseConfig,
      mutate: vi.fn(async (fn: (cfg: KlexConfig) => KlexConfig) =>
        fn(baseConfig),
      ),
      updateModelSelection: vi.fn(async () => baseConfig),
      ...config,
    } as unknown as Config,
    logger,
  };
}

function createApp(deps: SettingsRouteDependencies): OpenAPIHono {
  return setupTestApp((app) => {
    app.openapi(getModelSelectionRoute, getModelSelection(deps));
    app.openapi(patchModelSelectionRoute, patchModelSelection(deps));
    app.openapi(getTelemetryRoute, getTelemetry(deps));
    app.openapi(patchTelemetryRoute, patchTelemetry(deps));
  });
}

// ---------------------------------------------------------------------------
// GET /v1/settings/model-selection
// ---------------------------------------------------------------------------

describe('GET /v1/settings/model-selection', () => {
  it('returns the current model selection', async () => {
    const app = createApp(makeDeps());
    const response = await app.request('/v1/settings/model-selection');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(baseSelection);
  });

  it('returns all three purposes', async () => {
    const selection: ModelSelection = {
      chat: ['provider:endpoint:model-a', 'provider:endpoint:model-b'],
      compaction: ['provider:endpoint:model-c'],
      memory: [],
      routing: [],
    };
    const app = createApp(
      makeDeps({
        get: () => ({ ...baseConfig, modelSelection: selection }),
      }),
    );
    const response = await app.request('/v1/settings/model-selection');
    const body = (await response.json()) as ModelSelection;
    expect(body.chat).toEqual(selection.chat);
    expect(body.compaction).toEqual(selection.compaction);
    expect(body.memory).toEqual(selection.memory);
  });
});

// ---------------------------------------------------------------------------
// PATCH /v1/settings/model-selection
// ---------------------------------------------------------------------------

describe('PATCH /v1/settings/model-selection', () => {
  it('rejects invalid JSON body with 400', async () => {
    const app = createApp(makeDeps());
    const response = await app.request('/v1/settings/model-selection', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: '{invalid',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Malformed JSON in request body',
    });
  });

  it('rejects non-object body with 400', async () => {
    const app = createApp(makeDeps());
    const response = await app.request('/v1/settings/model-selection', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: '"not-an-object"',
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });

  it('rejects invalid model IDs with 400', async () => {
    const app = createApp(makeDeps());
    const response = await app.request('/v1/settings/model-selection', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat: ['invalid-no-colon'] }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Model ID');
  });

  it('updates a single field and preserves the others', async () => {
    const updatedConfig: KlexConfig = {
      ...baseConfig,
      modelSelection: {
        ...baseSelection,
        chat: ['anthropic:claude-3-haiku'],
      },
    };
    const mutateFn = vi.fn(async (fn: (cfg: KlexConfig) => KlexConfig) => {
      const next = fn(baseConfig);
      return { ...baseConfig, ...next } as KlexConfig;
    });
    const app = createApp(makeDeps({ mutate: mutateFn }));
    const response = await app.request('/v1/settings/model-selection', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat: ['anthropic:claude-3-haiku'] }),
    });
    expect(response.status).toBe(200);
    expect(mutateFn).toHaveBeenCalledOnce();
    const body = (await response.json()) as ModelSelection & {
      warnings: unknown[];
    };
    expect(body.chat).toEqual(['anthropic:claude-3-haiku']);
    expect(body.compaction).toEqual(baseSelection.compaction);
    expect(body.memory).toEqual(baseSelection.memory);
    expect(body.warnings).toEqual([]);
  });

  it('updates all fields at once', async () => {
    const newSelection: ModelSelection = {
      chat: ['openai:gpt-4o'],
      compaction: ['openai:gpt-4o-mini'],
      memory: ['anthropic:claude-3-haiku'],
      routing: [],
    };
    const mutateFn = vi.fn(async (fn: (cfg: KlexConfig) => KlexConfig) => {
      const next = fn(baseConfig);
      return { ...baseConfig, ...next } as KlexConfig;
    });
    const app = createApp(makeDeps({ mutate: mutateFn }));
    const response = await app.request('/v1/settings/model-selection', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(newSelection),
    });
    expect(response.status).toBe(200);
    expect(mutateFn).toHaveBeenCalledOnce();
    const body = await response.json();
    expect(body).toMatchObject(newSelection);
  });

  it('maps ConfigValidationError to 400', async () => {
    const app = createApp(
      makeDeps({
        mutate: vi.fn(async () => {
          throw new ConfigValidationError('Invalid model reference');
        }),
      }),
    );
    const response = await app.request('/v1/settings/model-selection', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat: ['openai:gpt-4o'] }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Invalid model reference');
  });

  it('maps unexpected errors to 500', async () => {
    const app = createApp(
      makeDeps({
        mutate: vi.fn(async () => {
          throw new Error('disk full');
        }),
      }),
    );
    const response = await app.request('/v1/settings/model-selection', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat: ['openai:gpt-4o'] }),
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: 'Failed to update model selection',
    });
  });

  it('preserves unset fields when patching with empty object', async () => {
    const mutateFn = vi.fn(async (fn: (cfg: KlexConfig) => KlexConfig) =>
      fn(baseConfig),
    );
    const app = createApp(makeDeps({ mutate: mutateFn }));
    const response = await app.request('/v1/settings/model-selection', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(200);
    expect(mutateFn).toHaveBeenCalledOnce();
  });

  // --- Provider / endpoint validation ---

  it('rejects unknown provider with 400', async () => {
    const app = createApp(makeDeps());
    const response = await app.request('/v1/settings/model-selection', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat: ['nonexistent:gpt-4o'] }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('unknown provider');
    expect(body.error).toContain('nonexistent');
  });

  it('rejects unknown endpoint on manual provider with 400', async () => {
    const app = createApp(makeDeps());
    const response = await app.request('/v1/settings/model-selection', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat: ['local:nonexistent:llama3'] }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('unknown endpoint');
    expect(body.error).toContain('local:nonexistent');
  });

  it('rejects manual provider model without endpoint ID with 400', async () => {
    const app = createApp(makeDeps());
    const response = await app.request('/v1/settings/model-selection', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat: ['local:llama3'] }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('without an endpoint ID');
  });

  it('rejects preset provider model with endpoint ID with 400', async () => {
    const app = createApp(makeDeps());
    const response = await app.request('/v1/settings/model-selection', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat: ['openai:default:gpt-4o'] }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('preset');
    expect(body.error).toContain('endpoint');
  });

  it('validates only the patched field, not preserved fields', async () => {
    // Preserved fields may reference unknown providers if the config is
    // already in that state; only the patched field is validated.
    const configWithUnknown: KlexConfig = {
      ...baseConfig,
      modelSelection: {
        chat: ['unknown-provider:some-model'],
        compaction: ['openai:gpt-4o-mini'],
        memory: ['anthropic:claude-3-haiku'],
      },
    };
    const app = createApp(
      makeDeps({
        get: () => configWithUnknown,
        mutate: vi.fn(async (fn: (cfg: KlexConfig) => KlexConfig) =>
          fn(configWithUnknown),
        ),
      }),
    );
    const response = await app.request('/v1/settings/model-selection', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ compaction: ['openai:gpt-4o'] }),
    });
    expect(response.status).toBe(200);
  });

  // --- knownModels warnings ---

  it('returns warnings for models not in knownModels on preset provider', async () => {
    const updatedConfig: KlexConfig = {
      ...baseConfig,
      modelSelection: {
        ...baseSelection,
        chat: ['openai:gpt-4o', 'openai:gpt-5-turbo'],
      },
    };
    const mutateFn = vi.fn(async (fn: (cfg: KlexConfig) => KlexConfig) =>
      fn(baseConfig),
    );
    const app = createApp(makeDeps({ mutate: mutateFn }));
    const response = await app.request('/v1/settings/model-selection', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat: ['openai:gpt-4o', 'openai:gpt-5-turbo'] }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as ModelSelection & {
      warnings: Array<{ modelId: string; message: string }>;
    };
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0]!.modelId).toBe('openai:gpt-5-turbo');
    expect(body.warnings[0]!.message).toContain('gpt-5-turbo');
    expect(body.warnings[0]!.message).toContain('knownModels');
  });

  it('returns warnings for models not in knownModels on manual provider', async () => {
    const updatedConfig: KlexConfig = {
      ...baseConfig,
      modelSelection: {
        ...baseSelection,
        chat: ['local:default:llama3', 'local:default:mistral'],
      },
    };
    const mutateFn = vi.fn(async (fn: (cfg: KlexConfig) => KlexConfig) =>
      fn(baseConfig),
    );
    const app = createApp(makeDeps({ mutate: mutateFn }));
    const response = await app.request('/v1/settings/model-selection', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat: ['local:default:llama3', 'local:default:mistral'],
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as ModelSelection & {
      warnings: Array<{ modelId: string; message: string }>;
    };
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0]!.modelId).toBe('local:default:mistral');
    expect(body.warnings[0]!.message).toContain('mistral');
    expect(body.warnings[0]!.message).toContain('knownModels');
  });

  it('returns no warnings when all models are in knownModels', async () => {
    const mutateFn = vi.fn(async (fn: (cfg: KlexConfig) => KlexConfig) =>
      fn(baseConfig),
    );
    const app = createApp(makeDeps({ mutate: mutateFn }));
    const response = await app.request('/v1/settings/model-selection', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat: ['openai:gpt-4o'] }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as ModelSelection & {
      warnings: unknown[];
    };
    expect(body.warnings).toEqual([]);
  });

  it('collects warnings across multiple purposes', async () => {
    const mutateFn = vi.fn(async (fn: (cfg: KlexConfig) => KlexConfig) =>
      fn(baseConfig),
    );
    const app = createApp(makeDeps({ mutate: mutateFn }));
    const response = await app.request('/v1/settings/model-selection', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat: ['openai:gpt-4o', 'openai:unknown-chat'],
        compaction: ['openai:gpt-4o-mini', 'openai:unknown-compaction'],
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as ModelSelection & {
      warnings: Array<{ modelId: string; message: string }>;
    };
    expect(body.warnings).toHaveLength(2);
    const warnedIds = body.warnings.map((w) => w.modelId);
    expect(warnedIds).toContain('openai:unknown-chat');
    expect(warnedIds).toContain('openai:unknown-compaction');
  });

  it('still persists when warnings are present', async () => {
    const mutateFn = vi.fn(async (fn: (cfg: KlexConfig) => KlexConfig) =>
      fn(baseConfig),
    );
    const app = createApp(makeDeps({ mutate: mutateFn }));
    const response = await app.request('/v1/settings/model-selection', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat: ['openai:unknown-model'] }),
    });
    expect(response.status).toBe(200);
    expect(mutateFn).toHaveBeenCalled();
    const body = (await response.json()) as ModelSelection & {
      warnings: Array<{ modelId: string; message: string }>;
    };
    expect(body.warnings).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/settings/telemetry
// ---------------------------------------------------------------------------

describe('GET /v1/settings/telemetry', () => {
  it('returns the configured telemetry level', async () => {
    const app = createApp(
      makeDeps({
        get: () => ({ ...baseConfig, telemetry: { level: 'reduced' } }),
      }),
    );
    const response = await app.request('/v1/settings/telemetry');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ level: 'reduced' });
  });

  it('returns the environment-aware default when not set', async () => {
    const app = createApp(makeDeps());
    const response = await app.request('/v1/settings/telemetry');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { level: string };
    expect(['off', 'minimum', 'reduced', 'full']).toContain(body.level);
  });
});

// ---------------------------------------------------------------------------
// PATCH /v1/settings/telemetry
// ---------------------------------------------------------------------------

describe('PATCH /v1/settings/telemetry', () => {
  it('updates the telemetry level', async () => {
    const mutateFn = vi.fn(async (fn: (cfg: KlexConfig) => KlexConfig) =>
      fn(baseConfig),
    );
    const app = createApp(makeDeps({ mutate: mutateFn }));
    const response = await app.request('/v1/settings/telemetry', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ level: 'minimum' }),
    });
    expect(response.status).toBe(200);
    expect(mutateFn).toHaveBeenCalledOnce();
    expect(await response.json()).toEqual({ level: 'minimum' });
  });

  it('rejects invalid level with 400', async () => {
    const app = createApp(makeDeps());
    const response = await app.request('/v1/settings/telemetry', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ level: 'verbose' }),
    });
    expect(response.status).toBe(400);
  });

  it('rejects malformed JSON with 400', async () => {
    const app = createApp(makeDeps());
    const response = await app.request('/v1/settings/telemetry', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: '{invalid',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Malformed JSON in request body',
    });
  });

  it('maps ConfigValidationError to 400', async () => {
    const app = createApp(
      makeDeps({
        mutate: vi.fn(async () => {
          throw new ConfigValidationError('Invalid telemetry');
        }),
      }),
    );
    const response = await app.request('/v1/settings/telemetry', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ level: 'off' }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Invalid telemetry');
  });

  it('maps unexpected errors to 500', async () => {
    const app = createApp(
      makeDeps({
        mutate: vi.fn(async () => {
          throw new Error('disk full');
        }),
      }),
    );
    const response = await app.request('/v1/settings/telemetry', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ level: 'off' }),
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: 'Failed to update telemetry settings',
    });
  });
});
