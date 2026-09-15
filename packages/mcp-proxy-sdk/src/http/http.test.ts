import { describe, expect, it, vi } from 'vitest';

import type {
  McpProxy,
  ProxyExchange,
  ProxyHeaders,
  ProxyRequest,
  ProxyResponseHead,
  Unsubscribe,
} from '../core/index.js';
import { createEnvironmentId, createProxyExchangeId } from '../core/index.js';
import { createProxyHttp } from './http.js';

class FakeExchange implements ProxyExchange {
  readonly id = createProxyExchangeId('exchange');
  readonly response: Promise<ProxyResponseHead>;
  readonly chunks = new Set<(data: string) => void>();
  readonly closes = new Set<(cause?: Error) => void>();
  readonly close = vi.fn(async () => {
    this.end();
  });
  constructor(head: ProxyResponseHead) {
    this.response = Promise.resolve(head);
  }
  onChunk(handler: (data: string) => void): Unsubscribe {
    this.chunks.add(handler);
    return () => this.chunks.delete(handler);
  }
  onClose(handler: (cause?: Error) => void): Unsubscribe {
    this.closes.add(handler);
    return () => this.closes.delete(handler);
  }
  emit(value: string) {
    for (const handler of this.chunks) handler(btoa(value));
  }
  end(cause?: Error) {
    for (const handler of this.closes) handler(cause);
  }
}

function setup(status = 200) {
  const exchange = new FakeExchange({
    status,
    statusText: status === 200 ? 'OK' : 'Unauthorized',
    headers: { 'content-type': 'text/plain', connection: 'close' },
  });
  let relayed: ProxyRequest | undefined;
  const proxy = {
    openExchange: vi.fn(async (_environment, request: ProxyRequest) => {
      relayed = request;
      return exchange;
    }),
    registerEnvironment: vi.fn(),
    close: vi.fn(),
  } as unknown as McpProxy;
  const handler = createProxyHttp({
    proxy,
    parseEnvironmentId: createEnvironmentId,
  });
  return { exchange, proxy, handler, relayed: () => relayed };
}

function request(body = '{}', headers: ProxyHeaders = {}) {
  return new Request('http://test/environments/environment/mcp', {
    method: 'POST',
    headers: {
      authorization: 'Bearer private',
      connection: 'keep-alive',
      'proxy-authorization': 'Bearer proxy-private',
      ...headers,
    },
    body,
  });
}

describe('ProxyHttp', () => {
  it('rejects unknown routes', async () => {
    const active = setup();
    expect(
      (await active.handler.fetch(new Request('http://test/mcp'))).status,
    ).toBe(404);
    expect(active.proxy.openExchange).not.toHaveBeenCalled();
  });

  it('relays sanitized request metadata and a streamed response', async () => {
    const active = setup();
    const response = await active.handler.fetch(
      request('{"ok":true}', { 'x-test': 'yes' }),
    );
    const reading = response.text();
    active.exchange.emit('one');
    active.exchange.emit('two');
    active.exchange.end();
    expect(await reading).toBe('onetwo');
    expect(active.relayed()).toMatchObject({
      method: 'POST',
      headers: {
        authorization: 'Bearer private',
        'x-test': 'yes',
      },
      body: btoa('{"ok":true}'),
    });
    expect(active.relayed()?.headers.authorization).toBe('Bearer private');
    expect(active.relayed()?.headers.connection).toBeUndefined();
    expect(active.relayed()?.headers['proxy-authorization']).toBeUndefined();
    expect(response.headers.get('connection')).toBeNull();
  });

  it('delegates the untouched request to a custom router', async () => {
    const active = setup();
    const original = request('{"remote":true}');
    const routeRequest = vi.fn(async ({ request: routedRequest }) => {
      expect(routedRequest).toBe(original);
      expect(routedRequest.bodyUsed).toBe(false);
      return new Response('remote', { status: 202 });
    });
    const handler = createProxyHttp({
      proxy: active.proxy,
      parseEnvironmentId: createEnvironmentId,
      routeRequest,
    });

    const response = await handler.fetch(original);

    expect(response.status).toBe(202);
    await expect(response.text()).resolves.toBe('remote');
    expect(routeRequest).toHaveBeenCalledOnce();
    expect(active.proxy.openExchange).not.toHaveBeenCalled();
  });

  it('lets a custom router select the existing local streaming path', async () => {
    const active = setup();
    const routeRequest = vi.fn(({ forwardLocal }) => forwardLocal());
    const handler = createProxyHttp({
      proxy: active.proxy,
      parseEnvironmentId: createEnvironmentId,
      routeRequest,
    });

    const response = await handler.fetch(request());
    const reading = response.text();
    active.exchange.emit('streamed');
    active.exchange.end();

    await expect(reading).resolves.toBe('streamed');
    expect(routeRequest).toHaveBeenCalledOnce();
    expect(active.proxy.openExchange).toHaveBeenCalledOnce();
  });

  it('reports router failures as unavailable', async () => {
    const active = setup();
    const onError = vi.fn();
    const handler = createProxyHttp({
      proxy: active.proxy,
      parseEnvironmentId: createEnvironmentId,
      routeRequest: async () => {
        throw new Error('owner unavailable');
      },
      hooks: { onError },
    });

    expect((await handler.fetch(request())).status).toBe(503);
    expect(onError).toHaveBeenCalledWith({
      error: expect.objectContaining({ message: 'owner unavailable' }),
    });
  });

  it('allows forwardLocal to be consumed only once', async () => {
    const active = setup();
    const handler = createProxyHttp({
      proxy: active.proxy,
      parseEnvironmentId: createEnvironmentId,
      routeRequest: async ({ forwardLocal }) => {
        const response = await forwardLocal();
        await expect(forwardLocal()).rejects.toThrow(
          'forwardLocal may only be called once',
        );
        return response;
      },
    });

    const response = await handler.fetch(request());
    active.exchange.end();
    await response.text();
  });

  it('passes environment authorization responses through', async () => {
    expect((await setup(401).handler.fetch(request())).status).toBe(401);
    expect((await setup(403).handler.fetch(request())).status).toBe(403);
  });

  it('propagates upstream failures and cancellation', async () => {
    const active = setup();
    const response = await active.handler.fetch(request());
    const reader = response.body?.getReader();
    await reader?.cancel('done');
    expect(active.exchange.close).toHaveBeenCalledOnce();

    const failed = setup();
    vi.mocked(failed.proxy.openExchange).mockRejectedValueOnce(
      new Error('offline'),
    );
    expect((await failed.handler.fetch(request())).status).toBe(503);
  });

  it('closes active exchanges idempotently', async () => {
    const active = setup();
    await active.handler.fetch(request());
    expect(active.handler.exchangeCount).toBe(1);
    await active.handler.close();
    await active.handler.close();
    expect(active.exchange.close).toHaveBeenCalledOnce();
    expect(active.handler.exchangeCount).toBe(0);
  });
});
