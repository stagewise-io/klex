import type { OpenAPIHono } from '@hono/zod-openapi';
import { describe, expect, it, vi } from 'vitest';

import type { ModuleLogger } from '@stagewise/logger';

import type {
  Mcp,
  PendingAuthorization,
  PendingAuthorizationInfo,
  RequestAuthorizationResult,
} from '@/mcp';

import {
  cancelAuthorization,
  cancelAuthorizationRoute,
  completeAuthorization,
  completeAuthorizationRoute,
  getPendingAuthorizations,
  getPendingAuthorizationsRoute,
  type McpOAuthRouteDependencies,
  startAuthorization,
  startAuthorizationRoute,
} from './mcp-oauth';
import { setupTestApp } from './test-utils';

const logger = {
  info: () => undefined,
  error: () => undefined,
} as unknown as ModuleLogger;

const pendingInfo: PendingAuthorizationInfo = {
  id: 'auth-1',
  serverName: 'qonto',
  serverUrl: 'https://qonto.example/mcp',
  createdAt: '2026-07-28T08:00:00.000Z',
  expiresAt: '2026-07-28T08:15:00.000Z',
};

const pending: PendingAuthorization = {
  ...pendingInfo,
  authorizationUrl: 'https://auth.qonto.example/authorize?state=secret-state',
  state: 'secret-state',
};

function makeDeps(mcp: Partial<Mcp> = {}): McpOAuthRouteDependencies {
  return {
    mcp: {
      listPendingAuthorizations: vi.fn(() => []),
      requestAuthorization: vi.fn(
        async (): Promise<RequestAuthorizationResult> => ({
          outcome: 'not_found',
        }),
      ),
      completeAuthorization: vi.fn(() => 'accepted' as const),
      cancelAuthorization: vi.fn(() => true),
      ...mcp,
    } as unknown as Mcp,
    logger,
  };
}

function app(deps: McpOAuthRouteDependencies): OpenAPIHono {
  return setupTestApp((instance) => {
    instance
      .openapi(getPendingAuthorizationsRoute, getPendingAuthorizations(deps))
      .openapi(startAuthorizationRoute, startAuthorization(deps))
      .openapi(completeAuthorizationRoute, completeAuthorization(deps))
      .openapi(cancelAuthorizationRoute, cancelAuthorization(deps));
  });
}

function post(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('GET /v1/mcp-oauth/pending', () => {
  it('returns the listing without authorization URLs or state', async () => {
    const deps = makeDeps({
      listPendingAuthorizations: vi.fn(() => [pendingInfo]),
    });
    const response = await app(deps).request(
      'http://localhost/v1/mcp-oauth/pending',
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      authorizations: Record<string, unknown>[];
    };
    expect(body.authorizations).toHaveLength(1);
    expect(body.authorizations[0]).not.toHaveProperty('authorizationUrl');
    expect(body.authorizations[0]).not.toHaveProperty('state');
    expect(body.authorizations[0]).toMatchObject({
      id: 'auth-1',
      serverName: 'qonto',
    });
  });
});

describe('POST /v1/mcp-oauth/authorizations', () => {
  it('returns the authorization URL and state for its single caller', async () => {
    const requestAuthorization = vi.fn(
      async (): Promise<RequestAuthorizationResult> => ({
        outcome: 'pending',
        authorization: pending,
      }),
    );
    const response = await app(makeDeps({ requestAuthorization })).request(
      post('/v1/mcp-oauth/authorizations', { serverName: 'qonto' }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: 'auth-1',
      serverName: 'qonto',
      serverUrl: 'https://qonto.example/mcp',
      authorizationUrl: pending.authorizationUrl,
      state: 'secret-state',
      expiresAt: pendingInfo.expiresAt,
    });
    expect(requestAuthorization).toHaveBeenCalledWith('qonto');
  });

  it.each([
    [{ outcome: 'not_found' } as RequestAuthorizationResult, 404],
    [
      {
        outcome: 'not_applicable',
        reason: 'stdio MCP servers do not use OAuth',
      } as RequestAuthorizationResult,
      409,
    ],
    [{ outcome: 'unavailable' } as RequestAuthorizationResult, 503],
    [{ outcome: 'timeout' } as RequestAuthorizationResult, 504],
  ])('maps outcome %j to status %i', async (outcome, status) => {
    const response = await app(
      makeDeps({ requestAuthorization: vi.fn(async () => outcome) }),
    ).request(post('/v1/mcp-oauth/authorizations', { serverName: 'qonto' }));

    expect(response.status).toBe(status);
    expect(await response.json()).toHaveProperty('error');
  });

  it('rejects a body without a server name', async () => {
    const response = await app(makeDeps()).request(
      post('/v1/mcp-oauth/authorizations', {}),
    );
    expect(response.status).toBe(400);
  });
});

describe('POST /v1/mcp-oauth/callback', () => {
  it('forwards callback parameters to the parked attempt', async () => {
    const completeAuthorizationSpy = vi.fn(() => 'accepted' as const);
    const response = await app(
      makeDeps({ completeAuthorization: completeAuthorizationSpy }),
    ).request(
      post('/v1/mcp-oauth/callback', {
        state: 'secret-state',
        code: 'auth-code',
      }),
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    const [state, params] = completeAuthorizationSpy.mock
      .calls[0] as unknown as [string, URLSearchParams];
    expect(state).toBe('secret-state');
    expect(params.get('code')).toBe('auth-code');
  });

  it('forwards provider errors', async () => {
    const completeAuthorizationSpy = vi.fn(() => 'accepted' as const);
    const response = await app(
      makeDeps({ completeAuthorization: completeAuthorizationSpy }),
    ).request(
      post('/v1/mcp-oauth/callback', {
        state: 'secret-state',
        error: 'access_denied',
        error_description: 'user said no',
      }),
    );

    expect(response.status).toBe(202);
    const [, params] = completeAuthorizationSpy.mock.calls[0] as unknown as [
      string,
      URLSearchParams,
    ];
    expect(params.get('error')).toBe('access_denied');
    expect(params.get('error_description')).toBe('user said no');
  });

  it('answers an unknown, expired or replayed state with 404', async () => {
    const response = await app(
      makeDeps({ completeAuthorization: vi.fn(() => 'unknown' as const) }),
    ).request(
      post('/v1/mcp-oauth/callback', { state: 'stale', code: 'auth-code' }),
    );

    expect(response.status).toBe(404);
  });

  it('rejects a body carrying neither a code nor an error', async () => {
    const completeAuthorizationSpy = vi.fn(() => 'accepted' as const);
    const response = await app(
      makeDeps({ completeAuthorization: completeAuthorizationSpy }),
    ).request(post('/v1/mcp-oauth/callback', { state: 'secret-state' }));

    expect(response.status).toBe(400);
    expect(completeAuthorizationSpy).not.toHaveBeenCalled();
  });

  it('rejects a body without a state', async () => {
    const response = await app(makeDeps()).request(
      post('/v1/mcp-oauth/callback', { code: 'auth-code' }),
    );
    expect(response.status).toBe(400);
  });
});

describe('DELETE /v1/mcp-oauth/authorizations/{id}', () => {
  it('cancels a pending authorization', async () => {
    const cancel = vi.fn(() => true);
    const response = await app(
      makeDeps({ cancelAuthorization: cancel }),
    ).request('http://localhost/v1/mcp-oauth/authorizations/auth-1', {
      method: 'DELETE',
    });

    expect(response.status).toBe(204);
    expect(cancel).toHaveBeenCalledWith('auth-1');
  });

  it('returns 404 for an unknown id', async () => {
    const response = await app(
      makeDeps({ cancelAuthorization: vi.fn(() => false) }),
    ).request('http://localhost/v1/mcp-oauth/authorizations/nope', {
      method: 'DELETE',
    });

    expect(response.status).toBe(404);
  });
});
