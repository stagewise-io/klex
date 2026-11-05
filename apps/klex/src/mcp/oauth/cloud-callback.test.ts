import { describe, expect, it, vi } from 'vitest';

import {
  createAgentClientMetadataUrlResolver,
  createCloudOAuthAuthorizationSessionFactory,
} from './cloud-callback';
import { McpPendingAuthorizationRegistry } from './pending-authorizations';

const context = {
  serverName: 'qonto',
  serverUrl: 'https://mcp.example.com/mcp',
};

describe('createCloudOAuthAuthorizationSessionFactory', () => {
  it('derives the public callback URL from the cloud base URL', async () => {
    const registry = new McpPendingAuthorizationRegistry();
    for (const baseUrl of [
      'https://cloud.example.com',
      'https://cloud.example.com/',
    ]) {
      const factory = createCloudOAuthAuthorizationSessionFactory({
        registry,
        getCloudBaseUrl: () => baseUrl,
      });
      const session = await factory.start(context);
      expect(session.redirectUrl.toString()).toBe(
        'https://cloud.example.com/v1/mcp-oauth/callback',
      );
      expect(session.clientMetadataUrl?.toString()).toBe(
        'https://cloud.example.com/v1/mcp-oauth/client.json',
      );
    }
  });

  it('keeps dynamic registration for an HTTP cloud, since CIMD needs HTTPS', async () => {
    const resolveAgentClientMetadataUrl = vi.fn();
    const factory = createCloudOAuthAuthorizationSessionFactory({
      registry: new McpPendingAuthorizationRegistry(),
      getCloudBaseUrl: () => 'http://localhost:5173',
      resolveAgentClientMetadataUrl,
    });
    const session = await factory.start(context);
    expect(session.clientMetadataUrl).toBeUndefined();
    expect(resolveAgentClientMetadataUrl).not.toHaveBeenCalled();
  });

  it('prefers the agent metadata document and falls back to the shared one', async () => {
    const agentUrl = new URL(
      'https://cloud.example.com/v1/agents/a/mcp-oauth/client.json',
    );
    const resolveAgentClientMetadataUrl = vi
      .fn()
      .mockResolvedValueOnce(agentUrl)
      .mockResolvedValueOnce(undefined);
    const factory = createCloudOAuthAuthorizationSessionFactory({
      registry: new McpPendingAuthorizationRegistry(),
      getCloudBaseUrl: () => 'https://cloud.example.com',
      resolveAgentClientMetadataUrl,
    });
    expect((await factory.start(context)).clientMetadataUrl).toBe(agentUrl);
    expect((await factory.start(context)).clientMetadataUrl?.toString()).toBe(
      'https://cloud.example.com/v1/mcp-oauth/client.json',
    );
    expect(resolveAgentClientMetadataUrl).toHaveBeenCalledWith(
      'https://cloud.example.com',
    );
  });

  it('registers a pending authorization that the registry can complete', async () => {
    const registry = new McpPendingAuthorizationRegistry();
    const factory = createCloudOAuthAuthorizationSessionFactory({
      registry,
      getCloudBaseUrl: () => 'https://cloud.example.com',
    });
    const session = await factory.start(context);

    const pending = session.authorize({
      authorizationUrl: new URL(
        'https://auth.example.com/authorize?state=secret',
      ),
      signal: new AbortController().signal,
      state: 'secret',
    });

    expect(registry.list()).toMatchObject([{ serverName: 'qonto' }]);

    // Mirrors `connectMcpServer`, which closes the session in a `finally` block
    // while still awaiting the authorization promise.
    await session.close();
    expect(registry.list()).toHaveLength(1);

    expect(
      registry.complete('secret', new URLSearchParams({ code: 'auth-code' })),
    ).toBe('accepted');
    expect((await pending).get('code')).toBe('auth-code');
  });

  it('honors a custom timeout', async () => {
    const registry = new McpPendingAuthorizationRegistry();
    const factory = createCloudOAuthAuthorizationSessionFactory({
      registry,
      getCloudBaseUrl: () => 'https://cloud.example.com',
      timeoutMs: 5,
    });
    const session = await factory.start(context);

    await expect(
      session.authorize({
        authorizationUrl: new URL('https://auth.example.com/authorize'),
        signal: new AbortController().signal,
        state: 'secret',
      }),
    ).rejects.toThrow('timed out');
  });
});

describe('createAgentClientMetadataUrlResolver', () => {
  const baseUrl = 'https://cloud.example.com/';
  const agentUrl =
    'https://cloud.example.com/v1/agents/a/mcp-oauth/client.json';

  function setup(responses: Array<Response | Error>) {
    const getAccessToken = vi.fn(async () => 'agent-token');
    const onError = vi.fn();
    const fetch = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) => {
        const next = responses.shift();
        if (!next || next instanceof Error) throw next ?? new Error('no reply');
        return next;
      },
    );
    const resolve = createAgentClientMetadataUrlResolver({
      getAccessToken,
      onError,
      fetch,
    });
    return { fetch, getAccessToken, onError, resolve };
  }

  it('asks Cloud with the agent token and caches the URL', async () => {
    const { fetch, getAccessToken, resolve } = setup([
      Response.json({ clientMetadataUrl: agentUrl }),
    ]);
    expect((await resolve(baseUrl))?.toString()).toBe(agentUrl);
    expect((await resolve(baseUrl))?.toString()).toBe(agentUrl);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(getAccessToken).toHaveBeenCalledWith(
      'https://cloud.example.com/v1',
      ['agent:access'],
    );
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url?.toString()).toBe(
      'https://cloud.example.com/v1/agent/mcp-oauth/client',
    );
    expect(new Headers(init?.headers).get('authorization')).toBe(
      'Bearer agent-token',
    );
  });

  it('falls back on 404 without reporting an error and asks again later', async () => {
    const { fetch, onError, resolve } = setup([
      Response.json({ error: 'not_found' }, { status: 404 }),
      Response.json({ clientMetadataUrl: agentUrl }),
    ]);
    expect(await resolve(baseUrl)).toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
    expect((await resolve(baseUrl))?.toString()).toBe(agentUrl);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['a server error', Response.json({}, { status: 503 })],
    ['a network error', new Error('offline')],
    ['a missing URL', Response.json({})],
    [
      'an HTTP URL',
      Response.json({ clientMetadataUrl: 'http://cloud.example.com/x' }),
    ],
  ])('falls back on %s', async (_label, reply) => {
    const { onError, resolve } = setup([reply]);
    expect(await resolve(baseUrl)).toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('falls back when no agent token is available', async () => {
    const resolve = createAgentClientMetadataUrlResolver({
      getAccessToken: () => Promise.reject(new Error('not enrolled')),
      fetch: vi.fn(),
    });
    expect(await resolve(baseUrl)).toBeUndefined();
  });
});
