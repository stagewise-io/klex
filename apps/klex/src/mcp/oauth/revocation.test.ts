import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ModuleLogger } from '@stagewise/logger';

import { revokeOAuthCredentials } from './revocation';
import type { ServerOAuthState } from './store';

const issuer = 'https://auth.example.com';
const warn = vi.fn();
const logger = { warn } as unknown as ModuleLogger;

function credentials(method = 'none', key = issuer): ServerOAuthState {
  return {
    clientInformationByIssuer: {
      [key]: {
        client_id: 'client',
        token_endpoint_auth_method: method,
        ...(method === 'none' ? {} : { client_secret: 'secret' }),
      },
    },
    clientRedirectUrlsByIssuer: {},
    tokensByIssuer: {
      [key]: {
        access_token: 'access',
        refresh_token: 'refresh',
        token_type: 'Bearer',
      },
    },
    discoveryState: { authorizationServerUrl: issuer },
  };
}

function metadata(overrides: Record<string, unknown> = {}) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    response_types_supported: ['code'],
    revocation_endpoint: `${issuer}/revoke`,
    revocation_endpoint_auth_methods_supported: [
      'none',
      'client_secret_basic',
      'client_secret_post',
    ],
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  warn.mockClear();
});

describe('MCP OAuth revocation', () => {
  it.each(['none', 'client_secret_basic', 'client_secret_post'])(
    'revokes refresh and access tokens with %s authentication',
    async (method) => {
      const requests: RequestInit[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url, init: RequestInit) => {
          if (init.method === 'POST') {
            requests.push(init);
            return new Response(null, { status: 200 });
          }
          return Response.json(metadata());
        }),
      );
      await revokeOAuthCredentials([credentials(method)], 'clay', logger);
      expect(
        requests.map((request) =>
          new URLSearchParams(request.body as string).get('token'),
        ),
      ).toEqual(['refresh', 'access']);
      expect(
        requests.map((request) =>
          new URLSearchParams(request.body as string).get('token_type_hint'),
        ),
      ).toEqual(['refresh_token', 'access_token']);
      for (const request of requests) {
        const body = new URLSearchParams(request.body as string);
        if (method === 'client_secret_basic') {
          expect(new Headers(request.headers).get('authorization')).toBe(
            `Basic ${btoa('client:secret')}`,
          );
          expect(body.has('client_secret')).toBe(false);
        } else {
          expect(body.get('client_id')).toBe('client');
          expect(body.get('client_secret')).toBe(
            method === 'none' ? null : 'secret',
          );
        }
      }
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it('uses saved discovery for legacy tokens without an issuer', async () => {
    const fetch = vi.fn(async (_url, init: RequestInit) =>
      init.method === 'POST'
        ? new Response(null, { status: 200 })
        : Response.json(metadata()),
    );
    vi.stubGlobal('fetch', fetch);
    await revokeOAuthCredentials(
      [credentials('none', '__default__')],
      'clay',
      logger,
    );
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    { revocation_endpoint: undefined },
    { revocation_endpoint: 'http://insecure.example/revoke' },
    { issuer: 'https://different.example' },
    { revocation_endpoint_auth_methods_supported: ['private_key_jwt'] },
  ])(
    'never sends credentials to an unsupported or untrusted endpoint: %j',
    async (overrides) => {
      const fetch = vi.fn(async (_url: unknown, _init: RequestInit) =>
        Response.json(metadata(overrides)),
      );
      vi.stubGlobal('fetch', fetch);
      await revokeOAuthCredentials([credentials()], 'clay', logger);
      expect(
        fetch.mock.calls.every(([_url, init]) => init.method !== 'POST'),
      ).toBe(true);
    },
  );

  it('does not send tokens under another issuer or client registration', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const state = credentials();
    state.clientInformationByIssuer[issuer] = {
      client_id: 'client',
      issuer: 'https://other.example',
    };
    await revokeOAuthCredentials([state], 'clay', logger);
    expect(fetch).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('continues after a failed refresh-token revocation and logs no provider content', async () => {
    const fetch = vi.fn(async (_url, init: RequestInit) =>
      init.method === 'POST'
        ? Response.json(
            { error: 'sensitive-provider-response' },
            { status: 503 },
          )
        : Response.json(metadata()),
    );
    vi.stubGlobal('fetch', fetch);
    await expect(
      revokeOAuthCredentials([credentials()], 'clay', logger),
    ).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(
      /sensitive-provider-response|secret|refresh/,
    );
  });

  it('bounds discovery and revocation with a shared timeout', async () => {
    const controller = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(controller.signal);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init: RequestInit) => {
        controller.abort();
        init.signal?.throwIfAborted();
        throw new Error('unreachable');
      }),
    );
    await expect(
      revokeOAuthCredentials([credentials()], 'clay', logger),
    ).resolves.toBeUndefined();
    expect(timeout).toHaveBeenCalledWith(5_000);
    expect(warn).toHaveBeenCalled();
  });
});
