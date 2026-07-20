import type { ModuleLogger } from '@stagewise/logger';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Config } from '../../../config/config';
import { ConfigValidationError } from '../../../config/config';
import type { FluidConfig } from '../../../config/types';
import { getConfig, putConfig, redactConfig } from './config';

const source: FluidConfig = {
  providers: {
    remote: {
      endpoints: {
        chat: {
          url: 'https://example.com/v1',
          format: 'openai-chat-completions',
          auth: { headers: { Authorization: 'Bearer secret' } },
          models: { model: {} },
        },
      },
    },
  },
  modelSelection: {
    chat: ['remote:chat:model'],
    compression: [],
    memory: [],
  },
  mcpServers: {
    remote: {
      url: 'https://example.com/mcp',
      headers: { 'x-api-key': 'secret' },
    },
  },
};

const logger = {
  error: () => undefined,
} as unknown as ModuleLogger;

function createApp(config: Config): Hono {
  const app = new Hono();
  const deps = { config, logger };
  app.get('/v1/config', getConfig(deps));
  app.put('/v1/config', putConfig(deps));
  return app;
}

function configWith(replace: Config['replace']): Config {
  return {
    start: async () => undefined,
    close: async () => undefined,
    get: () => source,
    replace,
    getModelSelection: (purpose) => source.modelSelection[purpose],
    resolveModel: () => {
      throw new Error('Not used');
    },
    getMcpServers: () => source.mcpServers,
  };
}

describe('config routes', () => {
  it('redacts provider and MCP headers without mutating source', () => {
    const redacted = redactConfig(source);

    expect(redacted.providers.remote?.endpoints.chat?.auth.headers).toEqual({
      Authorization: '[REDACTED]',
    });
    const mcpServer = redacted.mcpServers.remote;
    expect(
      mcpServer && 'url' in mcpServer ? mcpServer.headers : undefined,
    ).toEqual({ 'x-api-key': '[REDACTED]' });
    expect(source.providers.remote?.endpoints.chat?.auth.headers).toEqual({
      Authorization: 'Bearer secret',
    });
  });

  it('returns redacted config from GET and successful PUT', async () => {
    const app = createApp(configWith(async () => source));

    const getResponse = await app.request('/v1/config');
    expect(getResponse.status).toBe(200);
    expect(await getResponse.json()).toEqual(redactConfig(source));

    const putResponse = await app.request('/v1/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(source),
    });
    expect(putResponse.status).toBe(200);
    expect(await putResponse.json()).toEqual(redactConfig(source));
  });

  it('maps invalid JSON and config validation errors to 400', async () => {
    const app = createApp(
      configWith(async () => {
        throw new ConfigValidationError('Invalid config');
      }),
    );

    const jsonResponse = await app.request('/v1/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    expect(jsonResponse.status).toBe(400);

    const validationResponse = await app.request('/v1/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(validationResponse.status).toBe(400);
  });

  it('maps persistence failures to 500', async () => {
    const app = createApp(
      configWith(async () => {
        throw new Error('disk full');
      }),
    );

    const response = await app.request('/v1/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to update config' });
  });
});
