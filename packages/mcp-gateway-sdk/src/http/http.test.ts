import { describe, expect, it, vi } from 'vitest';

import type {
  Gateway,
  GatewayExchange,
  GatewayHeaders,
  GatewayRequest,
  GatewayResponseHead,
  Unsubscribe,
} from '../core/index.js';
import {
  createAgentId,
  createEnvironmentId,
  createGatewayExchangeId,
  createTenantId,
} from '../core/index.js';
import { createGatewayHttp } from './http.js';

class FakeExchange implements GatewayExchange {
  readonly id = createGatewayExchangeId('exchange');
  readonly response: Promise<GatewayResponseHead>;
  readonly chunks = new Set<(data: string) => void>();
  readonly closes = new Set<(cause?: Error) => void>();
  readonly close = vi.fn(async () => {
    this.end();
  });
  constructor(head: GatewayResponseHead) {
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

const tenantId = createTenantId('tenant');
const agent = {
  kind: 'agent' as const,
  tenantId,
  agentId: createAgentId('agent'),
};

function setup(authenticated = true) {
  const exchange = new FakeExchange({
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'text/plain', connection: 'close' },
  });
  let relayed: GatewayRequest | undefined;
  const gateway = {
    openExchange: vi.fn(
      async (_agent, _environment, request: GatewayRequest) => {
        relayed = request;
        return exchange;
      },
    ),
    registerEnvironment: vi.fn(),
    close: vi.fn(),
  } as unknown as Gateway;
  const handler = createGatewayHttp({
    gateway,
    authenticateAgent: async () => (authenticated ? agent : undefined),
    parseEnvironmentId: createEnvironmentId,
  });
  return { exchange, gateway, handler, relayed: () => relayed };
}

function request(body = '{}', headers: GatewayHeaders = {}) {
  return new Request('http://test/environments/environment/mcp', {
    method: 'POST',
    headers: {
      authorization: 'Bearer private',
      connection: 'keep-alive',
      ...headers,
    },
    body,
  });
}

describe('GatewayHttp', () => {
  it('rejects unknown routes and unauthenticated requests', async () => {
    const active = setup(false);
    expect(
      (await active.handler.fetch(new Request('http://test/mcp'))).status,
    ).toBe(404);
    expect((await active.handler.fetch(request())).status).toBe(401);
    expect(active.gateway.openExchange).not.toHaveBeenCalled();
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
      headers: { 'x-test': 'yes' },
      body: btoa('{"ok":true}'),
    });
    expect(active.relayed()?.headers.authorization).toBeUndefined();
    expect(active.relayed()?.headers.connection).toBeUndefined();
    expect(response.headers.get('connection')).toBeNull();
  });

  it('propagates upstream failures and cancellation', async () => {
    const active = setup();
    const response = await active.handler.fetch(request());
    const reader = response.body?.getReader();
    await reader?.cancel('done');
    expect(active.exchange.close).toHaveBeenCalledOnce();

    const failed = setup();
    vi.mocked(failed.gateway.openExchange).mockRejectedValueOnce(
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
