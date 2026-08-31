import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { McpOAuthProvider } from './provider';
import { McpOAuthStore } from './store';

const temporaryDirectories: string[] = [];

async function createProvider() {
  const directory = await mkdtemp(join(tmpdir(), 'klex-oauth-provider-'));
  temporaryDirectories.push(directory);
  const onAuthorizationRedirect = vi.fn();
  const provider = new McpOAuthProvider({
    onAuthorizationRedirect,
    redirectUrl: new URL('http://127.0.0.1:12345/oauth/callback'),
    serverName: 'qonto',
    store: new McpOAuthStore(join(directory, 'oauth.json')),
  });
  return { onAuthorizationRedirect, provider };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('McpOAuthProvider', () => {
  it('builds dynamic registration metadata', async () => {
    const { provider } = await createProvider();
    expect(provider.clientMetadata).toEqual({
      client_name: 'Klex Agent',
      grant_types: ['authorization_code', 'refresh_token'],
      redirect_uris: ['http://127.0.0.1:12345/oauth/callback'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  });

  it('persists SDK credentials and verifier', async () => {
    const { provider } = await createProvider();
    await provider.saveClientInformation(
      { client_id: 'dynamic-client', issuer: 'https://auth.example.com' },
      { issuer: 'https://auth.example.com' },
    );
    await provider.saveTokens(
      { access_token: 'access', token_type: 'Bearer' },
      { issuer: 'https://auth.example.com' },
    );
    await provider.saveCodeVerifier('verifier');

    await expect(
      provider.clientInformation({ issuer: 'https://auth.example.com' }),
    ).resolves.toMatchObject({ client_id: 'dynamic-client' });
    await expect(provider.tokens()).resolves.toMatchObject({
      access_token: 'access',
    });
    await expect(provider.codeVerifier()).resolves.toBe('verifier');
  });

  it('generates unpredictable state and delegates authorization redirects', async () => {
    const { onAuthorizationRedirect, provider } = await createProvider();
    const firstState = provider.state();
    const secondState = provider.state();
    const authorizationUrl = new URL('https://auth.example.com/authorize');

    expect(firstState).not.toBe(secondState);
    expect(Buffer.from(firstState, 'base64url')).toHaveLength(32);
    await provider.redirectToAuthorization(authorizationUrl);
    expect(onAuthorizationRedirect).toHaveBeenCalledWith(authorizationUrl);
  });

  it('fails closed when the verifier is missing', async () => {
    const { provider } = await createProvider();
    await expect(provider.codeVerifier()).rejects.toThrow(
      'No OAuth PKCE verifier exists',
    );
  });
});
