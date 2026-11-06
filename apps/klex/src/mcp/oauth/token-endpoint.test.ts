import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ModuleLogger } from '@stagewise/logger';

import { McpOAuthProvider } from './provider';
import { McpOAuthStore, parseTokenResponse } from './store';
import { createOAuthTokenEndpointFetch } from './token-endpoint';

const temporaryDirectories: string[] = [];
const serverName = 'grafana\u0000https://mcp.example.com/mcp';
const tokenUrl = 'https://auth.example.com/token';

async function setup(storedRefreshToken = 'refresh-1') {
  const directory = await mkdtemp(join(tmpdir(), 'klex-oauth-token-'));
  temporaryDirectories.push(directory);
  const store = new McpOAuthStore(join(directory, 'oauth.json'));
  await store.saveTokens(serverName, {
    access_token: 'expired',
    refresh_token: storedRefreshToken,
    token_type: 'Bearer',
  });
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  const create = (next: typeof fetch) =>
    createOAuthTokenEndpointFetch(next, {
      logger: logger as unknown as ModuleLogger,
      namespace: 'grafana',
      serverName,
      serverUrl: 'https://mcp.example.com/mcp',
      store,
    });
  const provider = new McpOAuthProvider({
    onAuthorizationRedirect: vi.fn(),
    redirectUrl: new URL('http://127.0.0.1:12345/oauth/callback'),
    serverName,
    store,
  });
  return { create, logger, provider, store };
}

function refresh(fetchImpl: typeof fetch, refreshToken: string) {
  return fetchImpl(tokenUrl, {
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
    method: 'POST',
  });
}

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    status,
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('createOAuthTokenEndpointFetch', () => {
  it('sends one refresh for concurrent callers and persists the rotated token', async () => {
    const { create, store } = await setup();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = vi.fn(async () => {
      await gate;
      return json(200, {
        access_token: 'access-2',
        expires_in: 3600,
        refresh_token: 'refresh-2',
        token_type: 'Bearer',
      });
    });
    const fetchImpl = create(next);

    const first = refresh(fetchImpl, 'refresh-1');
    const second = refresh(fetchImpl, 'refresh-1');
    release();
    const responses = await Promise.all([first, second]);

    expect(next).toHaveBeenCalledTimes(1);
    for (const response of responses) {
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        refresh_token: 'refresh-2',
      });
    }
    await expect(store.tokens(serverName)).resolves.toMatchObject({
      access_token: 'access-2',
      refresh_token: 'refresh-2',
    });
  });

  it('keeps the refresh token when the response omits a new one', async () => {
    const { create, store } = await setup();
    const fetchImpl = create(async () =>
      json(200, { access_token: 'access-2', token_type: 'Bearer' }),
    );
    await refresh(fetchImpl, 'refresh-1');
    await expect(store.tokens(serverName)).resolves.toMatchObject({
      access_token: 'access-2',
      refresh_token: 'refresh-1',
    });
  });

  it('does not restore tokens that were replaced while the refresh was in flight', async () => {
    const { create, store } = await setup();
    const fetchImpl = create(async () => {
      await store.invalidate(serverName, 'all');
      await store.saveTokens(serverName, {
        access_token: 'replacement',
        token_type: 'Bearer',
      });
      return json(200, {
        access_token: 'late',
        refresh_token: 'refresh-2',
        token_type: 'Bearer',
      });
    });
    await refresh(fetchImpl, 'refresh-1');
    await expect(store.tokens(serverName)).resolves.toMatchObject({
      access_token: 'replacement',
    });
  });

  it('skips the SDK write for a superseded refresh response', async () => {
    const { create, provider, store } = await setup();
    const fetchImpl = create(async () => {
      await store.saveTokens(serverName, {
        access_token: 'replacement',
        refresh_token: 'refresh-new-login',
        token_type: 'Bearer',
      });
      return json(200, {
        access_token: 'late',
        refresh_token: 'refresh-2',
        token_type: 'Bearer',
      });
    });
    const response = await refresh(fetchImpl, 'refresh-1');
    const body = parseTokenResponse(await response.json());
    if (!body) throw new Error('Expected a token response');
    // What the SDK does with a successful refresh response.
    await provider.saveTokens(body);
    await expect(store.tokens(serverName)).resolves.toMatchObject({
      access_token: 'replacement',
      refresh_token: 'refresh-new-login',
    });
    // Only the superseded set is skipped, and only once.
    await provider.saveTokens({ access_token: 'other', token_type: 'Bearer' });
    await expect(store.tokens(serverName)).resolves.toMatchObject({
      access_token: 'other',
    });
  });

  it('does not overwrite a newer token set that kept the same refresh token', async () => {
    const { create, store } = await setup();
    const fetchImpl = create(async () => {
      await store.saveTokens(serverName, {
        access_token: 'newer',
        refresh_token: 'refresh-1',
        token_type: 'Bearer',
      });
      return json(200, { access_token: 'older', token_type: 'Bearer' });
    });
    await refresh(fetchImpl, 'refresh-1');
    await expect(store.tokens(serverName)).resolves.toMatchObject({
      access_token: 'newer',
    });
  });

  it('keeps a rotated refresh token over a newer access token with the old one', async () => {
    const { create, provider, store } = await setup();
    const fetchImpl = create(async () => {
      await store.saveTokens(serverName, {
        access_token: 'newer',
        refresh_token: 'refresh-1',
        token_type: 'Bearer',
      });
      return json(200, {
        access_token: 'access-2',
        refresh_token: 'refresh-2',
        token_type: 'Bearer',
      });
    });
    const response = await refresh(fetchImpl, 'refresh-1');
    const body = parseTokenResponse(await response.json());
    if (!body) throw new Error('Expected a token response');
    await provider.saveTokens(body);
    await expect(store.tokens(serverName)).resolves.toMatchObject({
      access_token: 'access-2',
      refresh_token: 'refresh-2',
    });
  });

  it('does not replay non-rotating refresh responses', async () => {
    const { create } = await setup();
    let count = 0;
    const next = vi.fn(async () =>
      json(200, { access_token: `access-${++count}`, token_type: 'Bearer' }),
    );
    const fetchImpl = create(next);
    await refresh(fetchImpl, 'refresh-1');
    const second = await refresh(fetchImpl, 'refresh-1');
    expect(next).toHaveBeenCalledTimes(2);
    await expect(second.json()).resolves.toMatchObject({
      access_token: 'access-2',
    });
  });

  it('keeps newer tokens when a stale refresh token is rejected', async () => {
    const { create, provider, store } = await setup('refresh-2');
    const fetchImpl = create(async () =>
      json(400, {
        error: 'invalid_grant',
        error_description: 'Token has been rotated',
      }),
    );
    const response = await refresh(fetchImpl, 'refresh-1');
    expect(response.status).toBe(400);

    await provider.invalidateCredentials('tokens');
    await expect(store.tokens(serverName)).resolves.toMatchObject({
      refresh_token: 'refresh-2',
    });
  });

  it('clears tokens when the stored refresh token itself is rejected', async () => {
    const { create, logger, provider, store } = await setup();
    const fetchImpl = create(async () => json(400, { error: 'invalid_grant' }));
    await refresh(fetchImpl, 'refresh-1');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ oauthError: 'invalid_grant', status: 400 }),
      'MCP OAuth token request rejected',
    );

    await provider.invalidateCredentials('tokens');
    await expect(store.tokens(serverName)).resolves.toBeUndefined();
  });

  it('logs network failures and leaves stored tokens alone', async () => {
    const { create, logger, store } = await setup();
    const fetchImpl = create(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(refresh(fetchImpl, 'refresh-1')).rejects.toThrow(
      'fetch failed',
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ grantType: 'refresh_token' }),
      'MCP OAuth token request failed before a response',
    );
    await expect(store.tokens(serverName)).resolves.toMatchObject({
      refresh_token: 'refresh-1',
    });
  });

  it('passes non-token requests through unchanged', async () => {
    const { create } = await setup();
    const next = vi.fn(async () => new Response('ok'));
    const fetchImpl = create(next);
    const init = { body: '{"jsonrpc":"2.0"}', method: 'POST' };
    await fetchImpl('https://mcp.example.com/mcp', init);
    expect(next).toHaveBeenCalledWith('https://mcp.example.com/mcp', init);
  });
});
