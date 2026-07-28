import type { OpenAPIHono } from '@hono/zod-openapi';
import { describe, expect, it, vi } from 'vitest';

import type { ModuleLogger } from '@stagewise/logger';

import type { Config, FluidConfig, ModelSelection } from '@/config';
import { ConfigValidationError } from '@/config';

import {
  getModelSelection,
  getModelSelectionRoute,
  patchModelSelection,
  patchModelSelectionRoute,
  type SettingsRouteDependencies,
} from './settings';
import { setupTestApp } from './test-utils';

const logger = {
  error: () => undefined,
} as unknown as ModuleLogger;

const baseSelection: ModelSelection = {
  chat: ['openai:gpt-4o'],
  compression: ['openai:gpt-4o-mini'],
  memory: ['anthropic:claude-3-haiku'],
};

const baseConfig: FluidConfig = {
  providers: {},
  modelSelection: baseSelection,
  mcpServers: {},
};

function makeDeps(config: Partial<Config> = {}): SettingsRouteDependencies {
  return {
    config: {
      get: () => baseConfig,
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
      compression: ['provider:endpoint:model-c'],
      memory: [],
    };
    const app = createApp(
      makeDeps({
        get: () => ({ ...baseConfig, modelSelection: selection }),
      }),
    );
    const response = await app.request('/v1/settings/model-selection');
    const body = (await response.json()) as ModelSelection;
    expect(body.chat).toEqual(selection.chat);
    expect(body.compression).toEqual(selection.compression);
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
    const updatedConfig: FluidConfig = {
      ...baseConfig,
      modelSelection: {
        ...baseSelection,
        chat: ['anthropic:claude-3-opus'],
      },
    };
    const updateFn = vi.fn(async () => updatedConfig);
    const app = createApp(makeDeps({ updateModelSelection: updateFn }));
    const response = await app.request('/v1/settings/model-selection', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat: ['anthropic:claude-3-opus'] }),
    });
    expect(response.status).toBe(200);
    expect(updateFn).toHaveBeenCalledWith({
      chat: ['anthropic:claude-3-opus'],
      compression: baseSelection.compression,
      memory: baseSelection.memory,
    });
    const body = (await response.json()) as ModelSelection;
    expect(body.chat).toEqual(['anthropic:claude-3-opus']);
    expect(body.compression).toEqual(baseSelection.compression);
    expect(body.memory).toEqual(baseSelection.memory);
  });

  it('updates all fields at once', async () => {
    const newSelection: ModelSelection = {
      chat: ['google:gemini-pro'],
      compression: ['google:gemini-flash'],
      memory: ['openai:gpt-4o-mini'],
    };
    const updatedConfig: FluidConfig = {
      ...baseConfig,
      modelSelection: newSelection,
    };
    const updateFn = vi.fn(async () => updatedConfig);
    const app = createApp(makeDeps({ updateModelSelection: updateFn }));
    const response = await app.request('/v1/settings/model-selection', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(newSelection),
    });
    expect(response.status).toBe(200);
    expect(updateFn).toHaveBeenCalledWith(newSelection);
    expect(await response.json()).toEqual(newSelection);
  });

  it('maps ConfigValidationError to 400', async () => {
    const app = createApp(
      makeDeps({
        updateModelSelection: vi.fn(async () => {
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
        updateModelSelection: vi.fn(async () => {
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
    const updateFn = vi.fn(async () => baseConfig);
    const app = createApp(makeDeps({ updateModelSelection: updateFn }));
    const response = await app.request('/v1/settings/model-selection', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(200);
    expect(updateFn).toHaveBeenCalledWith(baseSelection);
  });
});
