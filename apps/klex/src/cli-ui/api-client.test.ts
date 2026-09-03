import { describe, expect, it, vi } from 'vitest';

import { AdminApiClient, AdminApiClientError } from './api-client';

function mockFetch(response: Response | Promise<Response>): typeof fetch {
  return vi.fn().mockReturnValue(response) as unknown as typeof fetch;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('AdminApiClient', () => {
  describe('construction', () => {
    it('uses default base URL', () => {
      const client = new AdminApiClient();
      expect(client).toBeDefined();
    });

    it('accepts custom base URL', () => {
      const client = new AdminApiClient('http://custom:9999');
      expect(client).toBeDefined();
    });
  });

  describe('providers', () => {
    it('getProviders sends GET to /v1/providers', async () => {
      const fetchMock = mockFetch(jsonResponse({ providers: [] }));
      const client = new AdminApiClient('http://test');
      globalThis.fetch = fetchMock;

      await client.getProviders();
      expect(fetchMock).toHaveBeenCalledWith(
        'http://test/v1/providers',
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('createProvider sends POST', async () => {
      const fetchMock = mockFetch(jsonResponse({ providers: [] }));
      const client = new AdminApiClient('http://test');
      globalThis.fetch = fetchMock;

      await client.createProvider({ name: 'test' });
      expect(fetchMock).toHaveBeenCalledWith(
        'http://test/v1/providers',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ name: 'test' }),
        }),
      );
    });

    it('deleteProvider sends DELETE with encoded name', async () => {
      const fetchMock = mockFetch(jsonResponse({ providers: [] }));
      const client = new AdminApiClient('http://test');
      globalThis.fetch = fetchMock;

      await client.deleteProvider('my provider');
      expect(fetchMock).toHaveBeenCalledWith(
        'http://test/v1/providers/my%20provider',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });

  describe('MCP', () => {
    it('getMcpServers sends GET to /v1/mcp-servers', async () => {
      const fetchMock = mockFetch(jsonResponse({ servers: [] }));
      const client = new AdminApiClient('http://test');
      globalThis.fetch = fetchMock;

      await client.getMcpServers();
      expect(fetchMock).toHaveBeenCalledWith(
        'http://test/v1/mcp-servers',
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('createMcpServer sends POST', async () => {
      const fetchMock = mockFetch(jsonResponse({ servers: [] }));
      const client = new AdminApiClient('http://test');
      globalThis.fetch = fetchMock;

      await client.createMcpServer({ name: 'test-server' });
      expect(fetchMock).toHaveBeenCalledWith(
        'http://test/v1/mcp-servers',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ name: 'test-server' }),
        }),
      );
    });
  });

  describe('cloud', () => {
    it('getCloudStatus sends GET to /v1/cloud/status', async () => {
      const fetchMock = mockFetch(
        jsonResponse({
          cloudEnabled: true,
          enrolled: false,
          clientId: null,
          enrolledAt: null,
          cloudBaseUrl: 'https://cloud.klex.bot',
          tunnelState: 'disconnected',
        }),
      );
      const client = new AdminApiClient('http://test');
      globalThis.fetch = fetchMock;

      const result = await client.getCloudStatus();
      expect(fetchMock).toHaveBeenCalledWith(
        'http://test/v1/cloud/status',
        expect.objectContaining({ method: 'GET' }),
      );
      expect(result.cloudEnabled).toBe(true);
    });

    it('enroll sends POST with enrollment code', async () => {
      const fetchMock = mockFetch(
        jsonResponse({ clientId: 'c1', enrolledAt: '2025-01-01' }),
      );
      const client = new AdminApiClient('http://test');
      globalThis.fetch = fetchMock;

      await client.enroll('MY-CODE');
      expect(fetchMock).toHaveBeenCalledWith(
        'http://test/v1/cloud/enroll',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ enrollmentCode: 'MY-CODE' }),
        }),
      );
    });
  });

  describe('error handling', () => {
    it('throws AdminApiClientError on non-ok response', async () => {
      // Each call consumes the Response, so return a new one each time
      const fetchMock = vi
        .fn()
        .mockImplementation(() => jsonResponse({ error: 'Not found' }, 404));
      const client = new AdminApiClient('http://test');
      globalThis.fetch = fetchMock;

      await expect(client.getProviders()).rejects.toThrow(AdminApiClientError);
      await expect(client.getProviders()).rejects.toThrow('Not found');
    });

    it('includes status code in error', async () => {
      const fetchMock = vi
        .fn()
        .mockImplementation(() => jsonResponse({ error: 'Server error' }, 500));
      const client = new AdminApiClient('http://test');
      globalThis.fetch = fetchMock;

      try {
        await client.getProviders();
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(AdminApiClientError);
        expect((error as AdminApiClientError).statusCode).toBe(500);
      }
    });
  });
});
