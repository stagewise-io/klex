import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { auth } from '@modelcontextprotocol/client';
import { afterEach, expect, test, vi } from 'vitest';

import { McpOAuthProvider } from './provider';
import { saveRegisteredOAuthClient } from './register-client';
import { McpOAuthStore } from './store';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

test('uses a supplied public client with PKCE and refresh scope, persists it and never registers dynamically', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'registered-mcp-'));
  directories.push(directory);
  const store = new McpOAuthStore(
    join(directory, 'credentials', 'mcp-oauth.json'),
  );
  const serverUrl = 'https://mcp.example.test/mcp';
  const issuer = 'https://auth.example.test';
  const redirectUrl = new URL(
    'https://cloud.example.test/v1/mcp-oauth/callback',
  );
  const requests: string[] = [];
  let rejectClient = true;
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    requests.push(url);
    if (url.includes('oauth-protected-resource'))
      return Response.json({
        resource: serverUrl,
        authorization_servers: [issuer],
        scopes_supported: ['mcp_api'],
      });
    if (url.includes('oauth-authorization-server'))
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/register`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    if (url === `${issuer}/token`) {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get('client_id')).toBe('customer-app');
      expect(body.has('client_secret')).toBe(false);
      expect(body.get('code_verifier')).toBeTruthy();
      if (rejectClient)
        return Response.json({ error: 'invalid_client' }, { status: 400 });
      return Response.json({
        access_token: 'access',
        refresh_token: 'refresh',
        token_type: 'Bearer',
        scope: 'mcp_api refresh_token',
      });
    }
    throw new Error(`Unexpected request ${url}`);
  });
  await saveRegisteredOAuthClient(
    store,
    'salesforce',
    serverUrl,
    redirectUrl,
    { clientId: 'customer-app', scope: 'mcp_api refresh_token' },
    fetcher,
  );
  const redirect = vi.fn();
  const provider = new McpOAuthProvider({
    redirectUrl,
    serverName: `salesforce\0${serverUrl}`,
    store,
    onAuthorizationRedirect: redirect,
  });
  expect(await auth(provider, { serverUrl, fetchFn: fetcher })).toBe(
    'REDIRECT',
  );
  const authorizationUrl = redirect.mock.calls[0]?.[0] as URL;
  expect(authorizationUrl.searchParams.get('client_id')).toBe('customer-app');
  expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe(
    'S256',
  );
  expect(authorizationUrl.searchParams.get('scope')).toBe(
    'mcp_api refresh_token',
  );
  expect(authorizationUrl.searchParams.get('state')).toBeTruthy();
  await expect(
    auth(provider, {
      serverUrl,
      authorizationCode: 'code',
      fetchFn: fetcher,
    }),
  ).rejects.toThrow();
  expect(await provider.clientInformation({ issuer })).toMatchObject({
    client_id: 'customer-app',
    klex_registered: true,
  });
  rejectClient = false;
  expect(await auth(provider, { serverUrl, fetchFn: fetcher })).toBe(
    'REDIRECT',
  );
  expect(
    await auth(provider, {
      serverUrl,
      authorizationCode: 'code',
      fetchFn: fetcher,
    }),
  ).toBe('AUTHORIZED');
  const restarted = new McpOAuthStore(
    join(directory, 'credentials', 'mcp-oauth.json'),
  );
  expect(
    await restarted.tokens(`salesforce\0${serverUrl}`, issuer),
  ).toMatchObject({ access_token: 'access', refresh_token: 'refresh', issuer });
  expect(
    await restarted.clientInformation(
      `salesforce\0${serverUrl}`,
      redirectUrl.href,
      issuer,
    ),
  ).toMatchObject({ client_id: 'customer-app', issuer });
  expect(
    await restarted.clientInformation(
      `other-bot\0${serverUrl}`,
      redirectUrl.href,
      issuer,
    ),
  ).toBeUndefined();
  expect(requests.some((url) => url.includes('register'))).toBe(false);
});

test('an aborted connection cannot save tokens over replacement credentials', async () => {
  const controller = new AbortController();
  const store = {
    saveTokens: vi.fn(),
    saveClientInformation: vi.fn(),
    invalidate: vi.fn(),
  } as unknown as McpOAuthStore;
  const provider = new McpOAuthProvider({
    redirectUrl: new URL('https://cloud.test/callback'),
    serverName: 'salesforce',
    store,
    signal: controller.signal,
    onAuthorizationRedirect: vi.fn(),
  });
  controller.abort();
  expect(() =>
    provider.saveTokens({ access_token: 'late', token_type: 'Bearer' }),
  ).toThrow();
  expect(() =>
    provider.saveClientInformation({ client_id: 'stale' }),
  ).toThrow();
  await expect(provider.invalidateCredentials('all')).rejects.toThrow();
  expect(store.saveTokens).not.toHaveBeenCalled();
  expect(store.saveClientInformation).not.toHaveBeenCalled();
  expect(store.invalidate).not.toHaveBeenCalled();
});
