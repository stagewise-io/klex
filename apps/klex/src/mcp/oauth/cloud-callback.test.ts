import { describe, expect, it } from 'vitest';

import { createCloudOAuthAuthorizationSessionFactory } from './cloud-callback';
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
    }
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
