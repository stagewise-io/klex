import type { OpenAPIHono } from '@hono/zod-openapi';
import { describe, expect, it, vi } from 'vitest';

import type { ModuleLogger } from '@stagewise/logger';

import type {
  ProviderOperationFailure,
  ProviderRegistry,
} from '@/provider-registry';

import {
  cancelProviderAuthorization,
  cancelProviderAuthorizationRoute,
  deleteProviderCredentials,
  deleteProviderCredentialsRoute,
  type ProviderAuthorizationRouteDependencies,
  startProviderAuthorization,
  startProviderAuthorizationRoute,
} from './providers.authorization';
import { setupTestApp } from './test-utils';

const logger = {
  info: vi.fn(),
  error: () => undefined,
} as unknown as ModuleLogger;

const failure = (
  code: ProviderOperationFailure['code'],
): ProviderOperationFailure => ({
  ok: false,
  code,
  message: `${code} message`,
});

function makeDeps(
  registry: Partial<ProviderRegistry> = {},
): ProviderAuthorizationRouteDependencies {
  return {
    providerRegistry: {
      startAuthorization: vi.fn(async () => failure('not_found')),
      cancelAuthorization: vi.fn(async () => failure('not_found')),
      signOut: vi.fn(async () => failure('not_found')),
      ...registry,
    } as unknown as ProviderRegistry,
    logger,
  };
}

function app(deps: ProviderAuthorizationRouteDependencies): OpenAPIHono {
  return setupTestApp((instance) => {
    instance
      .openapi(
        startProviderAuthorizationRoute,
        startProviderAuthorization(deps),
      )
      .openapi(
        cancelProviderAuthorizationRoute,
        cancelProviderAuthorization(deps),
      )
      .openapi(deleteProviderCredentialsRoute, deleteProviderCredentials(deps));
  });
}

const request = (method: string, path: string) =>
  new Request(`http://localhost${path}`, { method });

describe('PUT /v1/providers/{id}/authorization', () => {
  it('returns only the challenge needed by the user', async () => {
    const startAuthorization = vi.fn(async () => ({
      ok: true as const,
      code: 'available' as const,
      value: {
        id: 'attempt-1',
        verificationUri: 'https://auth.openai.com/codex/device',
        userCode: 'ABCD-EFGH',
        expiresAt: '2026-07-28T08:15:00.000Z',
        handle: { deviceAuthId: 'secret-device-id' },
        accessToken: 'secret-token',
      },
    }));
    const response = await app(
      makeDeps({
        startAuthorization,
      } as unknown as Partial<ProviderRegistry>),
    ).request(request('PUT', '/v1/providers/codex/authorization'));

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      id: 'attempt-1',
      verificationUri: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-EFGH',
      expiresAt: '2026-07-28T08:15:00.000Z',
    });
    expect(text).not.toContain('secret');
    expect(startAuthorization).toHaveBeenCalledWith('codex');
    expect(JSON.stringify(vi.mocked(logger.info).mock.calls)).not.toContain(
      'ABCD-EFGH',
    );
  });

  it.each([
    ['not_found', 404],
    ['conflict', 409],
    ['unsupported_operation', 409],
    ['internal_error', 500],
    ['connectivity_failed', 503],
  ] as const)('maps %s to HTTP %i', async (code, status) => {
    const response = await app(
      makeDeps({ startAuthorization: vi.fn(async () => failure(code)) }),
    ).request(request('PUT', '/v1/providers/codex/authorization'));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({
      error: `${code} message`,
      code,
    });
  });
});

describe('DELETE /v1/providers/{id}/authorization', () => {
  it('cancels a pending sign-in', async () => {
    const cancelAuthorization = vi.fn(async () => ({
      ok: true as const,
      code: 'available' as const,
      value: undefined,
    }));
    const response = await app(makeDeps({ cancelAuthorization })).request(
      request('DELETE', '/v1/providers/codex/authorization'),
    );
    expect(response.status).toBe(204);
    expect(cancelAuthorization).toHaveBeenCalledWith('codex');
  });

  it.each([
    ['not_found', 404],
    ['unsupported_operation', 409],
  ] as const)('maps %s to HTTP %i', async (code, status) => {
    const response = await app(
      makeDeps({ cancelAuthorization: vi.fn(async () => failure(code)) }),
    ).request(request('DELETE', '/v1/providers/codex/authorization'));
    expect(response.status).toBe(status);
  });
});

describe('DELETE /v1/providers/{id}/credentials', () => {
  it('signs out', async () => {
    const signOut = vi.fn(async () => ({
      ok: true as const,
      code: 'available' as const,
      value: undefined,
    }));
    const response = await app(makeDeps({ signOut })).request(
      request('DELETE', '/v1/providers/codex/credentials'),
    );
    expect(response.status).toBe(204);
    expect(signOut).toHaveBeenCalledWith('codex');
  });

  it.each([
    ['not_found', 404],
    ['unsupported_operation', 409],
    ['internal_error', 500],
  ] as const)('maps %s to HTTP %i', async (code, status) => {
    const response = await app(
      makeDeps({ signOut: vi.fn(async () => failure(code)) }),
    ).request(request('DELETE', '/v1/providers/codex/credentials'));
    expect(response.status).toBe(status);
  });
});
