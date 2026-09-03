import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { McpOAuthStore } from './store';

const temporaryDirectories: string[] = [];

async function createStore(): Promise<{
  filePath: string;
  store: McpOAuthStore;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'klex-oauth-store-'));
  temporaryDirectories.push(directory);
  const filePath = join(directory, 'oauth.json');
  return { filePath, store: new McpOAuthStore(filePath) };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('McpOAuthStore', () => {
  it('persists tokens per issuer and returns the most recently saved tokens without context', async () => {
    const { store } = await createStore();
    await store.saveTokens('qonto', {
      access_token: 'first-access',
      issuer: 'https://first.example.com',
      token_type: 'Bearer',
    });
    await store.saveTokens('qonto', {
      access_token: 'second-access',
      issuer: 'https://second.example.com',
      refresh_token: 'second-refresh',
      token_type: 'Bearer',
    });

    await expect(
      store.tokens('qonto', 'https://first.example.com'),
    ).resolves.toMatchObject({
      access_token: 'first-access',
    });
    await expect(store.tokens('qonto')).resolves.toMatchObject({
      access_token: 'second-access',
      refresh_token: 'second-refresh',
    });
  });

  it('persists client information, verifier, and discovery state across store instances', async () => {
    const { filePath, store } = await createStore();
    await store.saveClientInformation(
      'qonto',
      'http://127.0.0.1:12345/oauth/callback',
      { client_id: 'dynamic-client', issuer: 'https://auth.example.com' },
      'https://auth.example.com',
    );
    await store.saveCodeVerifier('qonto', 'verifier');
    await store.saveDiscoveryState('qonto', {
      authorizationServerUrl: 'https://auth.example.com',
      resourceMetadataUrl:
        'https://mcp.example.com/.well-known/oauth-protected-resource',
    });

    const restored = new McpOAuthStore(filePath);
    await expect(
      restored.clientInformation(
        'qonto',
        'http://127.0.0.1:12345/oauth/callback',
        'https://auth.example.com',
      ),
    ).resolves.toMatchObject({
      client_id: 'dynamic-client',
    });
    await expect(restored.codeVerifier('qonto')).resolves.toBe('verifier');
    await expect(restored.discoveryState('qonto')).resolves.toMatchObject({
      authorizationServerUrl: 'https://auth.example.com',
    });
  });

  it('does not reuse client information for a different redirect URI', async () => {
    const { store } = await createStore();
    await store.saveClientInformation(
      'qonto',
      'http://127.0.0.1:12345/oauth/callback',
      { client_id: 'dynamic-client' },
    );

    await expect(
      store.clientInformation('qonto', 'http://127.0.0.1:54321/oauth/callback'),
    ).resolves.toBeUndefined();
  });

  it('does not reuse legacy client information without redirect metadata', async () => {
    const { filePath, store } = await createStore();
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        servers: {
          qonto: {
            clientInformationByIssuer: {
              __default__: { client_id: 'legacy-client' },
            },
            tokensByIssuer: {},
          },
        },
      }),
    );

    await expect(
      store.clientInformation('qonto', 'http://127.0.0.1:12345/oauth/callback'),
    ).resolves.toBeUndefined();
  });

  it('writes credential storage with owner-only permissions', async () => {
    const { filePath, store } = await createStore();
    await store.saveTokens('qonto', {
      access_token: 'secret',
      token_type: 'Bearer',
    });

    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    expect(await readFile(filePath, 'utf8')).toContain('secret');
  });

  it('invalidates only the requested credential scope', async () => {
    const { store } = await createStore();
    await store.saveCodeVerifier('qonto', 'verifier');
    await store.saveTokens('qonto', {
      access_token: 'secret',
      token_type: 'Bearer',
    });

    await store.invalidate('qonto', 'tokens');

    await expect(store.tokens('qonto')).resolves.toBeUndefined();
    await expect(store.codeVerifier('qonto')).resolves.toBe('verifier');
  });

  it('serializes concurrent updates without losing credentials', async () => {
    const { store } = await createStore();
    await Promise.all([
      store.saveCodeVerifier('qonto', 'verifier'),
      store.saveTokens('qonto', {
        access_token: 'secret',
        token_type: 'Bearer',
      }),
      store.saveClientInformation(
        'qonto',
        'http://127.0.0.1:12345/oauth/callback',
        { client_id: 'dynamic-client' },
      ),
    ]);

    await expect(store.codeVerifier('qonto')).resolves.toBe('verifier');
    await expect(store.tokens('qonto')).resolves.toMatchObject({
      access_token: 'secret',
    });
    await expect(
      store.clientInformation('qonto', 'http://127.0.0.1:12345/oauth/callback'),
    ).resolves.toMatchObject({ client_id: 'dynamic-client' });
  });
});
