import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLogger } from '@stagewise/logger';

import { createTokenClient } from './token-client';

const logging = createLogger({ name: 'klex', type: 'hidden' });
const logger = logging.child({ name: 'token-client', bindings: {} });

const mockCloudBaseUrl = 'https://cloud.test.klex.bot';
const mockClientId = 'test-client-id';
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
          issuer: mockCloudBaseUrl,
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
    });

    const token = await client.getAccessToken('https://api.test.klex.bot', [
      'agent',
      'mcp:access',
    ]);

    expect(token).toBe('test-token-123');
    // 1 discovery + 1 token request = 2 fetches
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Second call should use cache — no new fetches
    const token2 = await client.getAccessToken('https://api.test.klex.bot', [
      'agent',
      'mcp:access',
    ]);
    expect(token2).toBe('test-token-123');
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    client.close();
  });

  it('re-fetches after token expires', async () => {
    const fetchSpy = createMockFetch({
      access_token: 'expired-token',
      token_type: 'Bearer',
      expires_in: 1, // 1 second
      scope: 'agent',
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const privateKey = await mockPrivateKey();
    const client = createTokenClient({
      logger,
      cloudBaseUrl: mockCloudBaseUrl,
      clientId: mockClientId,
      privateKey,
    });

    await client.getAccessToken('https://api.test.klex.bot', ['agent']);
    // 1 discovery + 1 token = 2
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Advance past expiry + safety buffer.
    // With expires_in=1, the proactive refresh (80% of 1s = 0.8s) also fires
    // within this window, causing an additional fetch.
    vi.advanceTimersByTime(70_000);

    const token = await client.getAccessToken('https://api.test.klex.bot', [
      'agent',
    ]);
    // Discovery cached. 1 proactive refresh + 1 expiry re-fetch = 2 more
    expect(token).toBe('expired-token');
    expect(fetchSpy).toHaveBeenCalledTimes(4);

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

  it('close() clears all timers and cache', async () => {
    const fetchSpy = createMockFetch({
      access_token: 'will-be-closed',
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
    });

    await client.getAccessToken('https://api.test.klex.bot', ['agent']);
    client.close();

    // Should not throw on second close
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

  it('throws on token request rejection', async () => {
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.includes('.well-known')) {
        return new Response(
          JSON.stringify({
            issuer: mockCloudBaseUrl,
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
    });

    await expect(
      client.getAccessToken('https://api.test.klex.bot', ['agent']),
    ).rejects.toThrow();

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
