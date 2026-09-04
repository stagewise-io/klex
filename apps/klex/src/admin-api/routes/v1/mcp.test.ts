import type { OpenAPIHono } from '@hono/zod-openapi';
import { describe, expect, it, vi } from 'vitest';

import type { ModuleLogger } from '@stagewise/logger';

import type { Config, KlexConfig } from '@/config';
import { ConfigValidationError } from '@/config';
import type { Mcp, McpServerInfo, McpToolCallRecord } from '@/mcp';

import {
  createMcpServer,
  createMcpServerRoute,
  deleteMcpServer,
  deleteMcpServerRoute,
  getMcpServer,
  getMcpServerRoute,
  getMcpServers,
  getMcpServersRoute,
  getMcpToolCallHistory,
  getMcpToolCallHistoryRoute,
  type McpRouteDependencies,
  updateMcpServer,
  updateMcpServerRoute,
} from './mcp';
import { setupTestApp } from './test-utils';

const logger = {
  error: () => undefined,
} as unknown as ModuleLogger;

const klexConfigStub = {} as Readonly<KlexConfig>;

function makeServerInfo(overrides: Partial<McpServerInfo> = {}): McpServerInfo {
  return {
    name: 'test-server',
    status: 'connected',
    toolCount: 3,
    supportsPushNotifications: false,
    supportsRealtimeMedia: false,
    transport: 'http',
    usesInteractiveOAuth: false,
    authorization: null,
    lastError: null,
    nextRetryAt: null,
    ...overrides,
  };
}

function makeToolCallRecord(
  overrides: Partial<McpToolCallRecord> = {},
): McpToolCallRecord {
  return {
    id: 'call-001',
    namespace: 'test-server',
    toolName: 'search',
    input: { query: 'hello' },
    result: { ok: true },
    isError: false,
    sessionId: 'session-001',
    startedAt: '2026-07-28T08:00:00.000Z',
    finishedAt: '2026-07-28T08:00:01.000Z',
    ...overrides,
  };
}

function makeDeps(
  config: Partial<Config> = {},
  mcp: Partial<Mcp> = {},
): McpRouteDependencies {
  return {
    config: {
      addMcpServer: vi.fn(async () => klexConfigStub),
      updateMcpServer: vi.fn(async () => klexConfigStub),
      removeMcpServer: vi.fn(async () => klexConfigStub),
      ...config,
    } as unknown as Config,
    mcp: {
      getServerStatuses: () => [],
      getToolCallHistory: () => [],
      ...mcp,
    } as unknown as Mcp,
    logger,
  };
}

function createApp(deps: McpRouteDependencies): OpenAPIHono {
  return setupTestApp((app) => {
    app.openapi(getMcpServersRoute, getMcpServers(deps));
    app.openapi(getMcpServerRoute, getMcpServer(deps));
    app.openapi(createMcpServerRoute, createMcpServer(deps));
    app.openapi(updateMcpServerRoute, updateMcpServer(deps));
    app.openapi(deleteMcpServerRoute, deleteMcpServer(deps));
    app.openapi(getMcpToolCallHistoryRoute, getMcpToolCallHistory(deps));
  });
}

// ---------------------------------------------------------------------------
// GET /v1/mcp-servers
// ---------------------------------------------------------------------------

describe('GET /v1/mcp-servers — list MCP servers', () => {
  it('returns an empty array when no servers are configured', async () => {
    const app = createApp(makeDeps());
    const response = await app.request('/v1/mcp-servers');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ servers: [] });
  });

  it('returns all server statuses with full detail', async () => {
    const servers = [
      makeServerInfo(),
      makeServerInfo({
        name: 'stdio-server',
        status: 'connecting',
        toolCount: 0,
        transport: 'stdio',
      }),
      makeServerInfo({
        name: 'errored-server',
        status: 'error',
        toolCount: 0,
        supportsPushNotifications: false,
      }),
    ];
    const app = createApp(makeDeps({}, { getServerStatuses: () => servers }));
    const response = await app.request('/v1/mcp-servers');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { servers: McpServerInfo[] };
    expect(body.servers).toHaveLength(3);
    expect(body.servers).toEqual(servers);
  });

  it('embeds a live authorization plus failure detail in the server row', async () => {
    const servers = [
      makeServerInfo({
        name: 'protected',
        status: 'authorizing',
        usesInteractiveOAuth: true,
        authorization: {
          id: 'auth-1',
          createdAt: '2026-07-28T08:00:00.000Z',
          expiresAt: '2026-07-28T08:15:00.000Z',
        },
      }),
      makeServerInfo({
        name: 'flaky',
        status: 'error',
        lastError: {
          name: 'Error',
          message: 'connect ECONNREFUSED',
          at: '2026-07-28T08:00:00.000Z',
        },
        nextRetryAt: '2026-07-28T08:00:30.000Z',
      }),
    ];
    const app = createApp(makeDeps({}, { getServerStatuses: () => servers }));
    const response = await app.request('/v1/mcp-servers');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { servers: McpServerInfo[] };
    expect(body.servers[0]?.authorization).toEqual({
      id: 'auth-1',
      createdAt: '2026-07-28T08:00:00.000Z',
      expiresAt: '2026-07-28T08:15:00.000Z',
    });
    expect(body.servers[1]?.lastError?.message).toBe('connect ECONNREFUSED');
    expect(body.servers[1]?.nextRetryAt).toBe('2026-07-28T08:00:30.000Z');
  });
});

// ---------------------------------------------------------------------------
// GET /v1/mcp-servers/{name}
// ---------------------------------------------------------------------------

describe('GET /v1/mcp-servers/{name} — read one MCP server', () => {
  it('returns the matching server row', async () => {
    const servers = [
      makeServerInfo({ name: 'other' }),
      makeServerInfo({ name: 'wanted', toolCount: 7 }),
    ];
    const app = createApp(makeDeps({}, { getServerStatuses: () => servers }));
    const response = await app.request('/v1/mcp-servers/wanted');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ server: servers[1] });
  });

  it('returns 404 with a machine-readable code for an unknown name', async () => {
    const app = createApp(makeDeps());
    const response = await app.request('/v1/mcp-servers/nope');
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'server_not_found' });
  });
});

// ---------------------------------------------------------------------------
// POST /v1/mcp-servers
// ---------------------------------------------------------------------------

describe('POST /v1/mcp-servers — create MCP server', () => {
  it('rejects invalid JSON body with 400', async () => {
    const app = createApp(makeDeps());
    const response = await app.request('/v1/mcp-servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{invalid',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Malformed JSON in request body',
      code: 'malformed_json',
    });
  });

  it('rejects body without a name field with 400', async () => {
    const app = createApp(makeDeps());
    const response = await app.request('/v1/mcp-servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/mcp' }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });

  it('rejects body with an empty name field with 400', async () => {
    const app = createApp(makeDeps());
    const response = await app.request('/v1/mcp-servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '', url: 'https://example.com/mcp' }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });

  it('rejects invalid MCP server config with 400', async () => {
    const app = createApp(makeDeps());
    const response = await app.request('/v1/mcp-servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'new-server', invalid: true }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });

  it('accepts a valid HTTP server config and returns 201 with updated statuses', async () => {
    const addMcpServerFn = vi.fn(async () => klexConfigStub);
    const statuses = [makeServerInfo({ name: 'new-server' })];
    const app = createApp(
      makeDeps(
        { addMcpServer: addMcpServerFn },
        { getServerStatuses: () => statuses },
      ),
    );
    const response = await app.request('/v1/mcp-servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'new-server',
        url: 'https://example.com/mcp',
      }),
    });
    expect(response.status).toBe(201);
    expect(addMcpServerFn).toHaveBeenCalledWith('new-server', {
      url: 'https://example.com/mcp',
    });
    const body = (await response.json()) as { servers: McpServerInfo[] };
    expect(body.servers).toEqual(statuses);
  });

  it('accepts a valid stdio server config', async () => {
    const addMcpServerFn = vi.fn(async () => klexConfigStub);
    const app = createApp(makeDeps({ addMcpServer: addMcpServerFn }));
    const response = await app.request('/v1/mcp-servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'new-server',
        command: 'node',
        args: ['server.js'],
        env: { NODE_ENV: 'production' },
      }),
    });
    expect(response.status).toBe(201);
    expect(addMcpServerFn).toHaveBeenCalledWith('new-server', {
      command: 'node',
      args: ['server.js'],
      env: { NODE_ENV: 'production' },
    });
  });

  it('accepts the explicit HTTP transport type used by other clients', async () => {
    const addMcpServerFn = vi.fn(async () => klexConfigStub);
    const app = createApp(makeDeps({ addMcpServer: addMcpServerFn }));
    const response = await app.request('/v1/mcp-servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'oauth-server',
        type: 'http',
        url: 'https://example.com/mcp',
      }),
    });

    expect(response.status).toBe(201);
    expect(addMcpServerFn).toHaveBeenCalledWith('oauth-server', {
      type: 'http',
      url: 'https://example.com/mcp',
    });
  });

  it('accepts streamable HTTP with pinned version negotiation', async () => {
    const addMcpServerFn = vi.fn(async () => klexConfigStub);
    const app = createApp(makeDeps({ addMcpServer: addMcpServerFn }));
    const response = await app.request('/v1/mcp-servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'modern-server',
        type: 'streamable-http',
        url: 'https://example.com/mcp',
        versionNegotiation: { pin: '2026-07-28' },
      }),
    });

    expect(response.status).toBe(201);
    expect(addMcpServerFn).toHaveBeenCalledWith('modern-server', {
      type: 'streamable-http',
      url: 'https://example.com/mcp',
      versionNegotiation: { pin: '2026-07-28' },
    });
  });

  it('accepts an Authorization header as an explicit OAuth override', async () => {
    const addMcpServerFn = vi.fn(async () => klexConfigStub);
    const app = createApp(makeDeps({ addMcpServer: addMcpServerFn }));
    const response = await app.request('/v1/mcp-servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'header-server',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer static-secret' },
      }),
    });

    expect(response.status).toBe(201);
    expect(addMcpServerFn).toHaveBeenCalledWith('header-server', {
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer static-secret' },
    });
  });

  it('accepts the explicit stdio transport type', async () => {
    const addMcpServerFn = vi.fn(async () => klexConfigStub);
    const app = createApp(makeDeps({ addMcpServer: addMcpServerFn }));
    const response = await app.request('/v1/mcp-servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'typed-stdio',
        type: 'stdio',
        command: 'node',
      }),
    });

    expect(response.status).toBe(201);
    expect(addMcpServerFn).toHaveBeenCalledWith('typed-stdio', {
      type: 'stdio',
      command: 'node',
    });
  });

  it('accepts versionNegotiation on an HTTP server config', async () => {
    const addMcpServerFn = vi.fn(async () => klexConfigStub);
    const app = createApp(makeDeps({ addMcpServer: addMcpServerFn }));
    const response = await app.request('/v1/mcp-servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'modern-server',
        url: 'https://example.com/mcp',
        versionNegotiation: { pin: '2025-06-18' },
      }),
    });
    expect(response.status).toBe(201);
    expect(addMcpServerFn).toHaveBeenCalledWith('modern-server', {
      url: 'https://example.com/mcp',
      versionNegotiation: { pin: '2025-06-18' },
    });
  });

  it('rejects unknown fields with 400', async () => {
    const app = createApp(makeDeps());
    const response = await app.request('/v1/mcp-servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'bad-server',
        url: 'https://example.com/mcp',
        bogus: true,
      }),
    });
    expect(response.status).toBe(400);
  });

  it('maps ConfigValidationError to 409', async () => {
    const app = createApp(
      makeDeps({
        addMcpServer: vi.fn(async () => {
          throw new ConfigValidationError("MCP server 'exists' already exists");
        }),
      }),
    );
    const response = await app.request('/v1/mcp-servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'exists',
        url: 'https://example.com/mcp',
      }),
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('already exists');
  });

  it('maps unexpected errors to 500', async () => {
    const app = createApp(
      makeDeps({
        addMcpServer: vi.fn(async () => {
          throw new Error('disk full');
        }),
      }),
    );
    const response = await app.request('/v1/mcp-servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'new-server',
        url: 'https://example.com/mcp',
      }),
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: 'Failed to create MCP server',
      code: 'internal_error',
    });
  });
});

// ---------------------------------------------------------------------------
// PATCH /v1/mcp-servers/:name
// ---------------------------------------------------------------------------

describe('PATCH /v1/mcp-servers/:name — update MCP server', () => {
  it('rejects invalid JSON body with 400', async () => {
    const app = createApp(makeDeps());
    const response = await app.request('/v1/mcp-servers/existing', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: '{invalid',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Malformed JSON in request body',
      code: 'malformed_json',
    });
  });

  it('rejects invalid MCP server config with 400', async () => {
    const app = createApp(makeDeps());
    const response = await app.request('/v1/mcp-servers/existing', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ invalid: true }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });

  it('updates an existing server and returns updated statuses', async () => {
    const updateMcpServerFn = vi.fn(async () => klexConfigStub);
    const statuses = [makeServerInfo({ name: 'existing' })];
    const app = createApp(
      makeDeps(
        { updateMcpServer: updateMcpServerFn },
        { getServerStatuses: () => statuses },
      ),
    );
    const response = await app.request('/v1/mcp-servers/existing', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://updated.com/mcp' }),
    });
    expect(response.status).toBe(200);
    expect(updateMcpServerFn).toHaveBeenCalledWith('existing', {
      url: 'https://updated.com/mcp',
    });
    const body = (await response.json()) as { servers: McpServerInfo[] };
    expect(body.servers).toEqual(statuses);
  });

  it('maps ConfigValidationError to 404', async () => {
    const app = createApp(
      makeDeps({
        updateMcpServer: vi.fn(async () => {
          throw new ConfigValidationError("MCP server 'missing' not found");
        }),
      }),
    );
    const response = await app.request('/v1/mcp-servers/missing', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/mcp' }),
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('not found');
  });

  it('maps unexpected errors to 500', async () => {
    const app = createApp(
      makeDeps({
        updateMcpServer: vi.fn(async () => {
          throw new Error('disk full');
        }),
      }),
    );
    const response = await app.request('/v1/mcp-servers/existing', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/mcp' }),
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: 'Failed to update MCP server',
      code: 'internal_error',
    });
  });
});

// ---------------------------------------------------------------------------
// DELETE /v1/mcp-servers/:name
// ---------------------------------------------------------------------------

describe('DELETE /v1/mcp-servers/:name — remove MCP server', () => {
  it('removes a server and returns updated statuses', async () => {
    const removeMcpServerFn = vi.fn(async () => klexConfigStub);
    const statuses: McpServerInfo[] = [];
    const app = createApp(
      makeDeps(
        { removeMcpServer: removeMcpServerFn },
        { getServerStatuses: () => statuses },
      ),
    );
    const response = await app.request('/v1/mcp-servers/old-server', {
      method: 'DELETE',
    });
    expect(response.status).toBe(200);
    expect(removeMcpServerFn).toHaveBeenCalledWith('old-server');
    const body = (await response.json()) as { servers: McpServerInfo[] };
    expect(body.servers).toEqual(statuses);
  });

  it('maps ConfigValidationError to 404', async () => {
    const app = createApp(
      makeDeps({
        removeMcpServer: vi.fn(async () => {
          throw new ConfigValidationError("MCP server 'missing' not found");
        }),
      }),
    );
    const response = await app.request('/v1/mcp-servers/missing', {
      method: 'DELETE',
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('not found');
  });

  it('maps unexpected errors to 500', async () => {
    const app = createApp(
      makeDeps({
        removeMcpServer: vi.fn(async () => {
          throw new Error('disk full');
        }),
      }),
    );
    const response = await app.request('/v1/mcp-servers/old-server', {
      method: 'DELETE',
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: 'Failed to delete MCP server',
      code: 'internal_error',
    });
  });
});

// ---------------------------------------------------------------------------
// GET /v1/mcp-servers/:name/tool-calls
// ---------------------------------------------------------------------------

describe('GET /v1/mcp-servers/:name/tool-calls — filtered tool call history', () => {
  it('filters records by namespace', async () => {
    const records = [
      makeToolCallRecord({ namespace: 'server-a' }),
      makeToolCallRecord({
        id: 'call-002',
        namespace: 'server-b',
        toolName: 'fetch',
      }),
      makeToolCallRecord({
        id: 'call-003',
        namespace: 'server-a',
        toolName: 'delete',
      }),
    ];
    const app = createApp(makeDeps({}, { getToolCallHistory: () => records }));
    const response = await app.request('/v1/mcp-servers/server-a/tool-calls');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { toolCalls: McpToolCallRecord[] };
    expect(body.toolCalls).toHaveLength(2);
    expect(body.toolCalls.every((r) => r.namespace === 'server-a')).toBe(true);
  });

  it('returns empty array when no records match the namespace', async () => {
    const records = [makeToolCallRecord({ namespace: 'server-a' })];
    const app = createApp(makeDeps({}, { getToolCallHistory: () => records }));
    const response = await app.request(
      '/v1/mcp-servers/nonexistent/tool-calls',
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ toolCalls: [] });
  });
});
