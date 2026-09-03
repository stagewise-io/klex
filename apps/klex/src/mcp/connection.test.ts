import { describe, expect, it, vi } from 'vitest';

import {
  type CloudAuthProvider,
  createTransport,
  resolveVersionNegotiation,
  shouldUseAutomaticOAuth,
} from './connection';
import { createDiscoveryAuthenticatedFetch } from './oauth/protected-resource';

function createCloud(tokens: string[]): CloudAuthProvider {
  return {
    getAccessToken: vi
      .fn()
      .mockImplementation(async () => tokens.shift() ?? 'fallback'),
    invalidate: vi.fn(),
    isTrustedAuthorizationServer: (issuer) =>
      issuer === 'https://cloud.example/api/auth',
  };
}

describe('MCP connection version negotiation', () => {
  it('defaults omitted policy to automatic negotiation', () => {
    expect(
      resolveVersionNegotiation({ url: 'https://example.com/mcp' }),
    ).toEqual({ mode: 'auto' });
  });

  it('passes through legacy negotiation', () => {
    expect(
      resolveVersionNegotiation({
        command: 'mcp-server',
        versionNegotiation: 'legacy',
      }),
    ).toEqual({ mode: 'legacy' });
  });

  it('passes through pinned negotiation', () => {
    expect(
      resolveVersionNegotiation({
        url: 'https://example.com/mcp',
        versionNegotiation: { pin: '2026-07-28' },
      }),
    ).toEqual({ mode: { pin: '2026-07-28' } });
  });
});

describe('MCP OAuth detection', () => {
  it('enables OAuth negotiation for a URL-only HTTP configuration', () => {
    expect(shouldUseAutomaticOAuth({ url: 'https://example.com/mcp' })).toBe(
      true,
    );
  });

  it('accepts a Claude-compatible explicit HTTP transport type', () => {
    expect(
      shouldUseAutomaticOAuth({
        type: 'http',
        url: 'https://example.com/mcp',
      }),
    ).toBe(true);
  });

  it('lets an explicit Authorization header take precedence', () => {
    expect(
      shouldUseAutomaticOAuth({
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer token' },
      }),
    ).toBe(false);
  });

  it('does not use HTTP OAuth for stdio servers', () => {
    expect(shouldUseAutomaticOAuth({ command: 'mcp-server' })).toBe(false);
  });
});

describe('createTransport cloud auth', () => {
  it('creates an HTTP transport without Cloud auth when no provider is given', () => {
    const transport = createTransport({
      url: 'https://example.com/mcp',
    });
    expect(transport).toBeDefined();
  });

  it('creates an HTTP transport with discovery auth when a provider is given', () => {
    const transport = createTransport(
      { url: 'https://example.com/mcp' },
      undefined,
      createCloud(['test-token']),
    );
    expect(transport).toBeDefined();
  });

  it('attaches neither discovery auth nor an authProvider when an Authorization header is configured', () => {
    const cloud = createCloud(['unused']);
    const config = {
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer static-secret' },
    };

    expect(shouldUseAutomaticOAuth(config)).toBe(false);

    const transport = createTransport(config, undefined, cloud);
    expect(transport).toBeDefined();
    expect(cloud.getAccessToken).not.toHaveBeenCalled();
  });
});

describe('MCP protected-resource discovery', () => {
  const resource = 'https://cloud.example/api/integrations/slack/mcp';
  const metadataUrl =
    'https://cloud.example/.well-known/oauth-protected-resource/api/integrations/slack/mcp';

  function unauthorizedWithChallenge(challenge: string): Response {
    return new Response(null, {
      status: 401,
      headers: { 'www-authenticate': challenge },
    });
  }

  function unauthorized(advertisedMetadataUrl = metadataUrl): Response {
    return unauthorizedWithChallenge(
      `Bearer error="invalid_token" resource_metadata="${advertisedMetadataUrl}" scope="mcp:use"`,
    );
  }

  function metadata(overrides: Record<string, unknown> = {}): Response {
    return Response.json({
      resource,
      authorization_servers: ['https://cloud.example/api/auth'],
      scopes_supported: ['mcp:use'],
      ...overrides,
    });
  }

  it('discovers trusted Cloud auth and preserves the request', async () => {
    const cloud = createCloud(['token-1']);
    const requests: Request[] = [];
    const body = JSON.stringify({ method: 'initialize' });
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url === metadataUrl) return metadata();
      if (!request.headers.has('authorization')) return unauthorized();
      return Response.json({
        authorization: request.headers.get('authorization'),
        body: await request.text(),
        custom: request.headers.get('x-custom'),
      });
    });
    const authenticatedFetch = createDiscoveryAuthenticatedFetch(
      cloud,
      resource,
      fetchImpl,
    );

    const response = await authenticatedFetch(resource, {
      method: 'POST',
      body,
      headers: { 'x-custom': 'value' },
    });

    await expect(response.json()).resolves.toEqual({
      authorization: 'Bearer token-1',
      body,
      custom: 'value',
    });
    expect(cloud.getAccessToken).toHaveBeenCalledWith(resource, ['mcp:use']);
    expect(
      requests
        .find((request) => request.url === metadataUrl)
        ?.headers.has('authorization'),
    ).toBe(false);
  });

  it.each([
    `Bearer ReSoUrCe_MeTaDaTa="${metadataUrl}" ScOpE="mcp:use"`,
    `Basic realm="legacy", Bearer resource_metadata="${metadataUrl}" scope="mcp:use"`,
  ])('discovers the Bearer challenge from %s', async (challenge) => {
    const cloud = createCloud(['token-1']);
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      if (request.url === metadataUrl) return metadata();
      if (!request.headers.has('authorization')) {
        return unauthorizedWithChallenge(challenge);
      }
      return new Response(null, { status: 200 });
    });
    const authenticatedFetch = createDiscoveryAuthenticatedFetch(
      cloud,
      resource,
      fetchImpl,
    );

    expect((await authenticatedFetch(resource)).status).toBe(200);
    expect(cloud.getAccessToken).toHaveBeenCalledWith(resource, ['mcp:use']);
  });

  it('refuses to attach a token when the resource query differs', async () => {
    const configuredResource = `${resource}?tenant=expected`;
    const requestedResource = `${resource}?tenant=other`;
    const cloud = createCloud(['unused']);
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      if (request.url === metadataUrl) {
        return metadata({ resource: configuredResource });
      }
      return unauthorized();
    });
    const authenticatedFetch = createDiscoveryAuthenticatedFetch(
      cloud,
      configuredResource,
      fetchImpl,
    );

    await expect(authenticatedFetch(requestedResource)).rejects.toThrow(
      'Refusing to send a Cloud token to a different resource',
    );
    expect(cloud.getAccessToken).not.toHaveBeenCalled();
  });

  it('caches discovery, refreshes once after 401, and never loops', async () => {
    const cloud = createCloud(['stale', 'fresh']);
    let resourceRequests = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      if (request.url === metadataUrl) return metadata();
      resourceRequests += 1;
      if (resourceRequests === 1) return unauthorized();
      return new Response(null, {
        status: request.headers.has('authorization') ? 401 : 500,
      });
    });
    const authenticatedFetch = createDiscoveryAuthenticatedFetch(
      cloud,
      resource,
      fetchImpl,
    );

    expect((await authenticatedFetch(resource)).status).toBe(401);
    expect((await authenticatedFetch(resource)).status).toBe(401);

    expect(cloud.invalidate).toHaveBeenCalledOnce();
    expect(cloud.getAccessToken).toHaveBeenCalledTimes(3);
    expect(
      fetchImpl.mock.calls.filter(
        ([input, init]) => new Request(input, init).url === metadataUrl,
      ),
    ).toHaveLength(1);
  });

  it('does not fetch metadata from an unsafe URL', async () => {
    const cloud = createCloud(['unused']);
    for (const unsafeMetadataUrl of [
      'https://internal.example/metadata',
      'https://user:password@cloud.example/metadata',
      'file:///etc/passwd',
      'not-a-url',
    ]) {
      const fetchImpl = vi.fn<typeof fetch>(async () =>
        unauthorized(unsafeMetadataUrl),
      );
      const authenticatedFetch = createDiscoveryAuthenticatedFetch(
        cloud,
        resource,
        fetchImpl,
      );

      expect((await authenticatedFetch(resource)).status).toBe(401);
      expect(fetchImpl).toHaveBeenCalledOnce();
    }
    expect(cloud.getAccessToken).not.toHaveBeenCalled();
  });

  it('leaves an untrusted issuer to generic OAuth without requesting a token', async () => {
    const cloud = createCloud(['unused']);
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      if (request.url === metadataUrl) {
        return metadata({ authorization_servers: ['https://foreign.example'] });
      }
      return unauthorized();
    });
    const authenticatedFetch = createDiscoveryAuthenticatedFetch(
      cloud,
      resource,
      fetchImpl,
    );

    expect((await authenticatedFetch(resource)).status).toBe(401);
    expect(cloud.getAccessToken).not.toHaveBeenCalled();
  });

  it('rejects trusted metadata with a conflicting resource or scope', async () => {
    const cloud = createCloud(['unused']);
    for (const overrides of [
      { resource: 'https://cloud.example/other' },
      { scopes_supported: ['other'] },
    ]) {
      const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        return request.url === metadataUrl
          ? metadata(overrides)
          : unauthorized();
      });
      const authenticatedFetch = createDiscoveryAuthenticatedFetch(
        cloud,
        resource,
        fetchImpl,
      );
      await expect(authenticatedFetch(resource)).rejects.toThrow(
        'Cloud MCP metadata',
      );
    }
    expect(cloud.getAccessToken).not.toHaveBeenCalled();
  });
});
