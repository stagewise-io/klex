import type { OpenAPIHono } from '@hono/zod-openapi';
import { describe, expect, it, vi } from 'vitest';

import type { ModuleLogger } from '@stagewise/logger';

import type {
  Mcp,
  PendingAuthorization,
  RequestAuthorizationResult,
} from '@/mcp';

import {
  cancelAuthorization,
  cancelAuthorizationRoute,
  completeAuthorization,
  completeAuthorizationRoute,
  type McpAuthorizationRouteDependencies,
  startAuthorization,
  startAuthorizationRoute,
} from './mcp.authorization';
import { setupTestApp } from './test-utils';

const logger = {
  info: () => undefined,
  error: () => undefined,
} as unknown as ModuleLogger;

const pending: PendingAuthorization = {
  id: 'auth-1',
  serverName: 'qonto',
  serverUrl: 'https://qonto.example/mcp',
  createdAt: '2026-07-28T08:00:00.000Z',
  expiresAt: '2026-07-28T08:15:00.000Z',
  authorizationUrl: 'https://auth.qonto.example/authorize?state=secret-state',
  state: 'secret-state',
};

function makeDeps(mcp: Partial<Mcp> = {}): McpAuthorizationRouteDependencies {
  return {
    mcp: {
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

function app(deps: McpAuthorizationRouteDependencies): OpenAPIHono {
  return setupTestApp((instance) => {
    instance
      .openapi(startAuthorizationRoute, startAuthorization(deps))
      .openapi(cancelAuthorizationRoute, cancelAuthorization(deps))
      .openapi(completeAuthorizationRoute, completeAuthorization(deps));
  });
}

function post(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function put(path: string): Request {
  return new Request(`http://localhost${path}`, { method: 'PUT' });
}

describe('PUT /v1/mcp-servers/{name}/authorization', () => {
  it('returns the authorization URL and state for its single caller', async () => {
    const requestAuthorization = vi.fn(
      async (): Promise<RequestAuthorizationResult> => ({
        outcome: 'pending',
        authorization: pending,
      }),
    );
    const response = await app(makeDeps({ requestAuthorization })).request(
      put('/v1/mcp-servers/qonto/authorization'),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: 'auth-1',
      serverName: 'qonto',
      serverUrl: 'https://qonto.example/mcp',
      authorizationUrl: pending.authorizationUrl,
      state: 'secret-state',
      expiresAt: pending.expiresAt,
    });
    expect(requestAuthorization).toHaveBeenCalledWith('qonto');
  });

  it('is idempotent: a repeat call returns the same live authorization', async () => {
    const requestAuthorization = vi.fn(
      async (): Promise<RequestAuthorizationResult> => ({
        outcome: 'pending',
        authorization: pending,
      }),
    );
    const instance = app(makeDeps({ requestAuthorization }));
    const first = await instance.request(
      put('/v1/mcp-servers/qonto/authorization'),
    );
    const second = await instance.request(
      put('/v1/mcp-servers/qonto/authorization'),
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await first.json()).toEqual(await second.json());
  });

  it.each([
    ['not_found', 404, 'server_not_found'],
    ['unsupported_transport', 409, 'unsupported_transport'],
    ['manual_credentials', 409, 'manual_credentials'],
    ['already_connected', 409, 'already_connected'],
    ['not_running', 503, 'not_running'],
    ['unavailable', 503, 'cloud_unavailable'],
    ['timeout', 504, 'authorization_timeout'],
  ] as const)('maps outcome %s to %i / %s', async (outcome, status, code) => {
    const response = await app(
      makeDeps({
        requestAuthorization: vi.fn(
          async () => ({ outcome }) as RequestAuthorizationResult,
        ),
      }),
    ).request(put('/v1/mcp-servers/qonto/authorization'));

    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ code });
  });
});

describe('DELETE /v1/mcp-servers/{name}/authorization', () => {
  it('cancels the authorization of the named server', async () => {
    const cancel = vi.fn(() => true);
    const response = await app(
      makeDeps({ cancelAuthorization: cancel }),
    ).request('http://localhost/v1/mcp-servers/qonto/authorization', {
      method: 'DELETE',
    });

    expect(response.status).toBe(204);
    expect(cancel).toHaveBeenCalledWith('qonto');
  });

  it('returns 404 when the server has no live authorization', async () => {
    const response = await app(
      makeDeps({ cancelAuthorization: vi.fn(() => false) }),
    ).request('http://localhost/v1/mcp-servers/qonto/authorization', {
      method: 'DELETE',
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      code: 'authorization_not_found',
    });
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
    expect(await response.json()).toMatchObject({ code: 'unknown_state' });
  });

  it('rejects a body carrying neither a code nor an error', async () => {
    const completeAuthorizationSpy = vi.fn(() => 'accepted' as const);
    const response = await app(
      makeDeps({ completeAuthorization: completeAuthorizationSpy }),
    ).request(post('/v1/mcp-oauth/callback', { state: 'secret-state' }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_callback' });
    expect(completeAuthorizationSpy).not.toHaveBeenCalled();
  });

  it('rejects a body without a state', async () => {
    const response = await app(makeDeps()).request(
      post('/v1/mcp-oauth/callback', { code: 'auth-code' }),
    );
    expect(response.status).toBe(400);
  });
});
