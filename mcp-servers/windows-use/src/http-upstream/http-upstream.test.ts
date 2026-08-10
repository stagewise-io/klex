import { describe, expect, it, vi } from 'vitest';

import { createHttpUpstream } from './http-upstream';

describe('HttpUpstream', () => {
  it('rewrites and forwards a request without buffering the response', async () => {
    const responseBody = new ReadableStream<Uint8Array>();
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const request = input instanceof Request ? input : new Request(input);
      expect(request.url).toBe('http://127.0.0.1:8123/mcp');
      expect(request.method).toBe('POST');
      expect(request.headers.get('mcp-protocol-version')).toBe('2026-07-28');
      expect(await request.text()).toBe('{"jsonrpc":"2.0"}');
      return new Response(responseBody, {
        status: 202,
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    const upstream = createHttpUpstream({
      url: 'http://127.0.0.1:8123/mcp',
      fetch,
    });

    const response = await upstream.fetch(
      new Request('https://gateway/environments/windows/mcp', {
        method: 'POST',
        headers: { 'mcp-protocol-version': '2026-07-28' },
        body: '{"jsonrpc":"2.0"}',
      }),
    );

    expect(response.status).toBe(202);
    expect(response.body).toBe(responseBody);
  });

  it('returns 503 when the upstream connection fails', async () => {
    const upstream = createHttpUpstream({
      url: 'http://127.0.0.1:8123/mcp',
      fetch: async () => {
        throw new Error('connection refused');
      },
    });

    const response = await upstream.fetch(new Request('https://gateway/mcp'));

    expect(response.status).toBe(503);
  });

  it('propagates cancellation failures', async () => {
    const controller = new AbortController();
    const upstream = createHttpUpstream({
      url: 'http://127.0.0.1:8123/mcp',
      fetch: async () => {
        controller.abort();
        throw new DOMException('aborted', 'AbortError');
      },
    });

    await expect(
      upstream.fetch(
        new Request('https://gateway/mcp', { signal: controller.signal }),
      ),
    ).rejects.toThrow('aborted');
  });

  it('returns 503 after idempotent close', async () => {
    const upstream = createHttpUpstream({
      url: 'http://127.0.0.1:8123/mcp',
    });

    await upstream.close();
    await upstream.close();

    expect(
      (await upstream.fetch(new Request('https://gateway/mcp'))).status,
    ).toBe(503);
  });
});
