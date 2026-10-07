import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { auth } from '@modelcontextprotocol/client';
import { expect, test, vi } from 'vitest';

import { McpOAuthProvider } from './provider';
import { saveRegisteredOAuthClient } from './register-client';
import { McpOAuthStore } from './store';

test('a registered confidential client completes PKCE and replaces its previous grant', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'confidential-mcp-'));
  try {
    const path = join(directory, 'credentials', 'mcp-oauth.json');
    const store = new McpOAuthStore(path);
    const serverUrl = 'https://mcp.example.test/';
    const issuer = 'https://auth.example.test';
    const redirectUrl = new URL(
      'https://cloud.example.test/v1/mcp-oauth/callback',
    );
    const key = `hubspot\0${serverUrl}`;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes('oauth-protected-resource'))
        return Response.json({
          resource: serverUrl,
          authorization_servers: [issuer],
        });
      if (url.includes('oauth-authorization-server'))
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['client_secret_post'],
        });
      if (url === `${issuer}/token`) {
        const body = new URLSearchParams(String(init?.body));
        expect(body.get('client_id')).toBe('registered-client');
        expect(body.get('client_secret')).toBe('test-only-secret');
        expect(body.get('code_verifier')).toBeTruthy();
        expect(body.get('redirect_uri')).toBe(redirectUrl.href);
        return Response.json({
          access_token: 'test-only-access',
          refresh_token: 'test-only-refresh',
          token_type: 'Bearer',
        });
      }
      throw new Error(`Unexpected request ${url}`);
    });
    await saveRegisteredOAuthClient(
      store,
      'hubspot',
      serverUrl,
      redirectUrl,
      { clientId: 'registered-client', clientSecret: 'test-only-secret' },
      fetcher,
    );
    const redirect = vi.fn();
    const provider = new McpOAuthProvider({
      redirectUrl,
      serverName: key,
      store,
      onAuthorizationRedirect: redirect,
    });
    expect(await auth(provider, { serverUrl, fetchFn: fetcher })).toBe(
      'REDIRECT',
    );
    const authorizationUrl = redirect.mock.calls[0]?.[0] as URL;
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe(
      'S256',
    );
    expect(authorizationUrl.searchParams.has('client_secret')).toBe(false);
    expect(
      await auth(provider, {
        serverUrl,
        authorizationCode: 'test-code',
        fetchFn: fetcher,
      }),
    ).toBe('AUTHORIZED');
    const restarted = new McpOAuthStore(path);
    expect(await restarted.tokens(key, issuer)).toMatchObject({
      refresh_token: 'test-only-refresh',
    });
    expect(
      await restarted.clientInformation(key, redirectUrl.href, issuer),
    ).toMatchObject({ client_secret: 'test-only-secret' });
    expect(
      await restarted.clientInformation(
        key,
        'https://other.test/callback',
        issuer,
      ),
    ).toBeUndefined();
    expect(
      await restarted.clientInformation(
        key,
        redirectUrl.href,
        'https://other-issuer.test',
      ),
    ).toBeUndefined();
    await saveRegisteredOAuthClient(
      restarted,
      'hubspot',
      serverUrl,
      redirectUrl,
      { clientId: 'replacement', clientSecret: 'replacement-secret' },
      fetcher,
    );
    expect(await restarted.tokens(key, issuer)).toBeUndefined();
    expect(
      await restarted.clientInformation(key, redirectUrl.href, issuer),
    ).toMatchObject({ client_id: 'replacement' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
