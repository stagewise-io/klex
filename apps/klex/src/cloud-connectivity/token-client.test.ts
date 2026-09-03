import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLogger } from '@stagewise/logger';

import { createTokenClient } from './token-client';

const logging = createLogger({ name: 'klex', type: 'hidden' });
const logger = logging.child({ name: 'token-client', bindings: {} });

const mockCloudBaseUrl = 'https://cloud.test.klex.bot';
const mockClientId = 'test-client-id';
const mockIssuer = `${mockCloudBaseUrl}/api/auth`;
const mockTokenEndpoint = `${mockCloudBaseUrl}/api/auth/oauth2/token`;

// Helper: create a real Ed25519 private key via Web Crypto API
async function mockPrivateKey(): Promise<CryptoKey> {
  const result = await crypto.subtle.generateKey('Ed25519', false, ['sign']);
  if ('privateKey' in result) {
    return result.privateKey;
  }
  return result;
}

// Helper: create a mock fetch that returns discovery metadata for
// .well-known URLs and token responses for token endpoint requests.
function createMockFetch(tokenBody: {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
}): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();

    if (url.includes('.well-known')) {
      return new Response(
        JSON.stringify({
          issuer: mockIssuer,
          token_endpoint: mockTokenEndpoint,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    return new Response(JSON.stringify(tokenBody), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as ReturnType<typeof vi.fn>;
}

// Helper: mock fetch that serves discovery normally but returns a caller-
// supplied raw Response for the token endpoint.
function createMockFetchWithTokenResponse(
  tokenResponse: () => Response,
): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();

    if (url.includes('.well-known')) {
      return new Response(
        JSON.stringify({
          issuer: mockIssuer,
          token_endpoint: mockTokenEndpoint,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    return tokenResponse();
  }) as unknown as ReturnType<typeof vi.fn>;
}

async function captureTokenError(
  tokenResponse: () => Response,
): Promise<string> {
  globalThis.fetch = createMockFetchWithTokenResponse(
    tokenResponse,
  ) as unknown as typeof globalThis.fetch;

  const privateKey = await mockPrivateKey();
  const client = createTokenClient({
    logger,
    cloudBaseUrl: mockCloudBaseUrl,
    clientId: mockClientId,
    privateKey,
    privateKeyKid: 'test-key-id',
  });

  try {
    await client.getAccessToken('https://api.test.klex.bot', ['agent']);
    throw new Error('Expected token acquisition to fail');
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    client.close();
  }
}

describe('TokenClient', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.useFakeTimers();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it('fetches and caches a token', async () => {
    const fetchSpy = createMockFetch({
      access_token: 'test-token-123',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'agent mcp:access',
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const privateKey = await mockPrivateKey();
    const client = createTokenClient({
      logger,
      cloudBaseUrl: mockCloudBaseUrl,
      clientId: mockClientId,
      privateKey,
      privateKeyKid: 'test-key-id',
    });

    const token = await client.getAccessToken('https://api.test.klex.bot', [
      'agent',
      'mcp:access',
    ]);

    expect(token).toBe('test-token-123');
    // 1 discovery + 1 token request = 2 fetches
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      `${mockIssuer}/.well-known/openid-configuration`,
    );

    const tokenRequestInit = fetchSpy.mock.calls[1]?.[1] as
      | RequestInit
      | undefined;
    expect(tokenRequestInit?.body).toBeInstanceOf(URLSearchParams);
    if (!(tokenRequestInit?.body instanceof URLSearchParams)) {
      throw new Error('Expected token request body');
    }
    const assertion = tokenRequestInit.body.get('client_assertion');
    expect(assertion).not.toBeNull();
    const encodedHeader = assertion?.split('.')[0];
    if (!encodedHeader) throw new Error('Expected client assertion header');
    const protectedHeader = JSON.parse(
      Buffer.from(encodedHeader, 'base64url').toString('utf8'),
    ) as { alg: string; kid?: string };
    expect(protectedHeader).toEqual({ alg: 'EdDSA', kid: 'test-key-id' });

    // Second call should use cache — no new fetches
    const token2 = await client.getAccessToken('https://api.test.klex.bot', [
      'agent',
      'mcp:access',
    ]);
    expect(token2).toBe('test-token-123');
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    client.close();
  });

  it('caches tokens independently by resource and scopes', async () => {
    const fetchSpy = createMockFetch({
      access_token: 'test-token-123',
      token_type: 'Bearer',
      expires_in: 3600,
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const privateKey = await mockPrivateKey();
    const client = createTokenClient({
      logger,
      cloudBaseUrl: mockCloudBaseUrl,
      clientId: mockClientId,
      privateKey,
      privateKeyKid: 'test-key-id',
    });
    const resource = 'https://api.test.klex.bot';

    await client.getAccessToken(resource, ['agent:access']);
    await client.getAccessToken(resource, ['mcp:access']);
    await client.getAccessToken(resource, ['agent:access']);

    // One discovery request and one token request per distinct scope set.
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const agentTokenBody = fetchSpy.mock.calls[1]?.[1]?.body;
    const mcpTokenBody = fetchSpy.mock.calls[2]?.[1]?.body;
    expect(agentTokenBody).toBeInstanceOf(URLSearchParams);
    expect(mcpTokenBody).toBeInstanceOf(URLSearchParams);
    if (
      !(agentTokenBody instanceof URLSearchParams) ||
      !(mcpTokenBody instanceof URLSearchParams)
    ) {
      throw new Error('Expected token request bodies');
    }
    expect(agentTokenBody.get('scope')).toBe('agent:access');
    expect(mcpTokenBody.get('scope')).toBe('mcp:access');

    client.close();
  });

  it('re-fetches when a token enters the expiry safety window', async () => {
    const fetchSpy = createMockFetch({
      access_token: 'expired-token',
      token_type: 'Bearer',
      expires_in: 120,
      scope: 'agent',
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const privateKey = await mockPrivateKey();
    const client = createTokenClient({
      logger,
      cloudBaseUrl: mockCloudBaseUrl,
      clientId: mockClientId,
      privateKey,
      privateKeyKid: 'test-key-id',
    });

    await client.getAccessToken('https://api.test.klex.bot', ['agent']);
    // 1 discovery + 1 token = 2
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Enter the 60-second safety window before the proactive refresh at 80% TTL.
    vi.advanceTimersByTime(61_000);

    const token = await client.getAccessToken('https://api.test.klex.bot', [
      'agent',
    ]);
    // Discovery is cached, so only the stale token is fetched again.
    expect(token).toBe('expired-token');
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    client.close();
  });

  it('invalidate() clears cache for a resource', async () => {
    const fetchSpy = createMockFetch({
      access_token: 'cached-token',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'agent',
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const privateKey = await mockPrivateKey();
    const client = createTokenClient({
      logger,
      cloudBaseUrl: mockCloudBaseUrl,
      clientId: mockClientId,
      privateKey,
      privateKeyKid: 'test-key-id',
    });

    await client.getAccessToken('https://api.test.klex.bot', ['agent']);
    // 1 discovery + 1 token = 2
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    client.invalidate('https://api.test.klex.bot');

    await client.getAccessToken('https://api.test.klex.bot', ['agent']);
    // Discovery cached, only 1 new token fetch
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    client.close();
  });

  it('proactive refresh timer fires at 80% TTL', async () => {
    const fetchSpy = createMockFetch({
      access_token: 'refreshed-token',
      token_type: 'Bearer',
      expires_in: 100, // 100 seconds
      scope: 'agent',
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const privateKey = await mockPrivateKey();
    const client = createTokenClient({
      logger,
      cloudBaseUrl: mockCloudBaseUrl,
      clientId: mockClientId,
      privateKey,
      privateKeyKid: 'test-key-id',
    });

    await client.getAccessToken('https://api.test.klex.bot', ['agent']);
    // 1 discovery + 1 token = 2
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Advance to 80% of TTL (80 seconds)
    vi.advanceTimersByTime(80_000);

    // Wait for the async refresh to complete
    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    });

    client.close();
  });

  it('enforces backoff between rejected token exchanges', async () => {
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.includes('.well-known')) {
        return new Response(
          JSON.stringify({
            issuer: mockIssuer,
            token_endpoint: mockTokenEndpoint,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      return new Response(
        JSON.stringify({
          error: 'invalid_client',
          error_description: 'Invalid client assertion',
        }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      );
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const privateKey = await mockPrivateKey();
    const client = createTokenClient({
      logger,
      cloudBaseUrl: mockCloudBaseUrl,
      clientId: mockClientId,
      privateKey,
      privateKeyKid: 'test-key-id',
    });

    const resource = 'https://api.test.klex.bot';
    await expect(client.getAccessToken(resource, ['agent'])).rejects.toThrow();
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const retry = expect(
      client.getAccessToken(resource, ['agent']),
    ).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await retry;
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    client.close();
  });

  it('deduplicates concurrent requests for the same resource', async () => {
    const fetchSpy = createMockFetch({
      access_token: 'dedup-token',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'agent',
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const privateKey = await mockPrivateKey();
    const client = createTokenClient({
      logger,
      cloudBaseUrl: mockCloudBaseUrl,
      clientId: mockClientId,
      privateKey,
      privateKeyKid: 'test-key-id',
    });

    // Two concurrent requests for the same resource should result in a
    // single token fetch (plus the discovery request).
    const [token1, token2] = await Promise.all([
      client.getAccessToken('https://api.test.klex.bot', ['agent']),
      client.getAccessToken('https://api.test.klex.bot', ['agent']),
    ]);

    expect(token1).toBe('dedup-token');
    expect(token2).toBe('dedup-token');
    // 1 discovery + 1 token (not 2 tokens)
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    client.close();
  });
});

describe('TokenClient — refresh retry', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.useFakeTimers();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it('retries proactive refresh with exponential backoff after failure', async () => {
    let tokenCallCount = 0;
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.includes('.well-known')) {
        return new Response(
          JSON.stringify({
            issuer: mockIssuer,
            token_endpoint: mockTokenEndpoint,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      tokenCallCount += 1;
      if (tokenCallCount === 2) {
        // Second call: proactive refresh fails (simulate 500)
        return new Response('server error', { status: 500 });
      }
      // First call (initial) and third+ (retry) succeed
      return new Response(
        JSON.stringify({
          access_token: 'recovered-token',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'agent',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const privateKey = await mockPrivateKey();
    const client = createTokenClient({
      logger,
      cloudBaseUrl: mockCloudBaseUrl,
      clientId: mockClientId,
      privateKey,
      privateKeyKid: 'test-key-id',
    });

    // Initial fetch succeeds (tokenCallCount=1)
    await client.getAccessToken('https://api.test.klex.bot', ['agent']);
    expect(tokenCallCount).toBe(1);

    // Trigger proactive refresh at 80% TTL (expires_in=3600 → 2880s)
    vi.advanceTimersByTime(2880_000);

    // The refresh attempt fails (tokenCallCount=2), should schedule a retry
    await vi.waitFor(() => {
      expect(tokenCallCount).toBe(2);
    });

    // Advance past the first retry delay (~2s + jitter)
    vi.advanceTimersByTime(3000);

    // Retry should succeed (tokenCallCount=3)
    await vi.waitFor(() => {
      expect(tokenCallCount).toBe(3);
    });

    client.close();
  });

  describe('failure diagnostics', () => {
    it('reports status, status text, and content type for a gateway error', async () => {
      const message = await captureTokenError(
        () =>
          new Response(
            '<html><body><h1>503 Service Temporarily Unavailable</h1></body></html>',
            {
              status: 503,
              statusText: 'Service Unavailable',
              headers: { 'Content-Type': 'text/html' },
            },
          ),
      );

      // Without these details a transient edge failure is indistinguishable
      // from an authorization-server regression.
      expect(message).toContain('HTTP 503');
      expect(message).toContain('Service Unavailable');
      expect(message).toContain('text/html');
      expect(message).toContain('503 Service Temporarily Unavailable');
    });

    it('redacts credentials from a non-conformant success body', async () => {
      const message = await captureTokenError(
        () =>
          new Response(
            JSON.stringify({
              access_token: 'super-secret-token-value',
              refresh_token: 'super-secret-refresh-value',
              token_type: 'Bearer',
              expires_in: 'not-a-number',
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            },
          ),
      );

      expect(message).toContain('HTTP 200');
      expect(message).not.toContain('super-secret-token-value');
      expect(message).not.toContain('super-secret-refresh-value');
      expect(message).toContain('[redacted]');
    });

    it('redacts a credential under a JSON-escaped property name', async () => {
      // `JSON.parse` decodes `access\u005ftoken` to `access_token`, so a
      // raw-text scan alone would leak the value.
      const message = await captureTokenError(
        () =>
          new Response('{"access\\u005ftoken":"super-secret-token-value"}', {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      );

      expect(message).not.toContain('super-secret-token-value');
      expect(message).toContain('[redacted]');
    });

    it('redacts submitted credentials echoed back by the server', async () => {
      // A server or proxy that echoes the request body would otherwise expose
      // the `private_key_jwt` assertion.
      const message = await captureTokenError(
        () =>
          new Response(
            'invalid_request: client_assertion=super-secret-assertion-value&grant_type=client_credentials',
            {
              status: 400,
              headers: { 'Content-Type': 'text/plain' },
            },
          ),
      );

      expect(message).not.toContain('super-secret-assertion-value');
      expect(message).toContain('[redacted]');
    });

    it('redacts a credential nested inside an error object', async () => {
      const message = await captureTokenError(
        () =>
          new Response(
            JSON.stringify({
              error: 'invalid_client',
              sent: { client_secret: 'super-secret-client-value' },
            }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
          ),
      );

      expect(message).not.toContain('super-secret-client-value');
      expect(message).toContain('[redacted]');
    });

    it('redacts a credential embedded in a string value', async () => {
      const message = await captureTokenError(
        () =>
          new Response(
            JSON.stringify({
              error_description: 'rejected access_token=super-secret-embedded',
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          ),
      );

      expect(message).not.toContain('super-secret-embedded');
      expect(message).toContain('[redacted]');
    });

    it('preserves diagnostic fields whose names merely end in a keyword', async () => {
      // `error_code` must survive: redacting it would defeat the purpose of
      // capturing the body at all.
      const message = await captureTokenError(
        () =>
          new Response(
            JSON.stringify({
              error_code: 'AS-4711',
              expires_in: 'not-a-number',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      );

      expect(message).toContain('AS-4711');
    });

    // Both delimiters crossed with both value forms. Covering only some
    // combinations is how the bare colon-delimited case slipped through, so the
    // grid is enumerated explicitly.
    const nonJsonCredentialBodies = [
      ['bare key, colon, bare value', 'client_assertion: SECRET'],
      ['bare key, equals, bare value', 'client_assertion=SECRET'],
      ['quoted key, colon, quoted value', '"client_assertion": "SECRET"'],
      ['quoted key, equals, quoted value', '"client_assertion"="SECRET"'],
      ['single-quoted value', "client_assertion: 'SECRET'"],
      ['padded colon', 'client_assertion   :   SECRET'],
      ['uppercase key', 'CLIENT_ASSERTION: SECRET'],
    ] as const;

    it.each(nonJsonCredentialBodies)(
      'redacts a credential in non-JSON text (%s)',
      async (_label, pair) => {
        const message = await captureTokenError(
          () =>
            new Response(`upstream rejected request\n${pair}\ntrailing text`, {
              status: 400,
              headers: { 'Content-Type': 'text/plain' },
            }),
        );

        expect(message).not.toContain('SECRET');
        expect(message).toContain('[redacted]');
        // The surrounding diagnostic context must survive redaction.
        expect(message).toContain('upstream rejected request');
        expect(message).toContain('trailing text');
      },
    );

    it('truncates an oversized diagnostic body', async () => {
      const message = await captureTokenError(
        () =>
          new Response('x'.repeat(4096), {
            status: 502,
            headers: { 'Content-Type': 'text/plain' },
          }),
      );

      expect(message).toContain('HTTP 502');
      expect(message).toContain('[truncated]');
      expect(message.length).toBeLessThan(1024);
    });
  });
});
