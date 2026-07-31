import { once } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';

import {
  createProxyExchangeId,
  decodeEnvironmentToProxyFrame,
  encodeProxyFrame,
  MAX_PROXY_CHUNK_BYTES,
  type ProxyToEnvironmentFrame,
} from '../../../core/index.js';
import {
  createProxyDaemon,
  type ProxyDaemon,
  type ProxyEnvironmentHandler,
} from './proxy-daemon.js';

const resources: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.allSettled(resources.splice(0).map((close) => close()));
});

async function createServer() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  resources.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No server port');
  return { server, url: new URL(`ws://127.0.0.1:${address.port}/environment`) };
}
function frame(socket: WebSocket, value: ProxyToEnvironmentFrame): void {
  socket.send(encodeProxyFrame(value));
}
async function nextFrame(socket: WebSocket) {
  const [data] = await once(socket, 'message');
  return decodeEnvironmentToProxyFrame(data.toString());
}
function open(
  exchangeId: ReturnType<typeof createProxyExchangeId>,
): ProxyToEnvironmentFrame {
  return {
    version: 2,
    type: 'exchange.open',
    exchangeId,
    method: 'POST',
    url: 'https://environment.invalid/mcp',
    headers: { 'x-test': 'yes' },
    body: btoa('hello'),
  };
}
function daemon(url: URL, handler: ProxyEnvironmentHandler): ProxyDaemon {
  const value = createProxyDaemon({
    connection: () => ({
      url,
      headers: { authorization: 'Bearer secret' },
    }),
    handler,
    reconnect: { initialDelayMs: 5, maximumDelayMs: 10, jitter: 0 },
  });
  resources.push(() => value.close());
  return value;
}

describe('ProxyDaemon', () => {
  it('authenticates, reconstructs requests, and streams bounded chunks', async () => {
    const { server, url } = await createServer();
    const accepted = once(server, 'connection');
    const seen: Request[] = [];
    const handler = {
      fetch: vi.fn(async (request: Request) => {
        seen.push(request);
        return new Response(
          new Uint8Array(MAX_PROXY_CHUNK_BYTES + 1).fill(65),
          {
            status: 201,
            headers: { 'x-response': 'yes' },
          },
        );
      }),
      close: vi.fn(async () => undefined),
    };
    const active = daemon(url, handler);
    await active.start();
    const [socket] = (await accepted) as [WebSocket];
    const received: ReturnType<typeof decodeEnvironmentToProxyFrame>[] = [];
    socket.on('message', (data) =>
      received.push(decodeEnvironmentToProxyFrame(data.toString())),
    );
    const id = createProxyExchangeId('first');
    frame(socket, open(id));
    await vi.waitFor(() => expect(received).toHaveLength(4));
    expect(received[0]).toMatchObject({ type: 'exchange.opened', status: 201 });
    expect(received[1]?.type).toBe('exchange.chunk');
    expect(received[2]?.type).toBe('exchange.chunk');
    expect(received[3]).toMatchObject({ type: 'exchange.close' });
    expect(await seen[0]?.text()).toBe('hello');
    expect(seen[0]?.headers.get('x-test')).toBe('yes');
    expect(active.activeExchangeCount).toBe(0);
  });

  it('propagates handler failure and proxy cancellation', async () => {
    const { server, url } = await createServer();
    const accepted = once(server, 'connection');
    let signal: AbortSignal | undefined;
    const handler = {
      fetch: vi
        .fn<(request: Request) => Promise<Response>>()
        .mockRejectedValueOnce(new Error('failed'))
        .mockImplementationOnce(async (request) => {
          signal = request.signal;
          return new Response(new ReadableStream({ start() {} }));
        }),
      close: vi.fn(async () => undefined),
    };
    const active = daemon(url, handler);
    await active.start();
    const [socket] = (await accepted) as [WebSocket];
    frame(socket, open(createProxyExchangeId('bad')));
    expect(await nextFrame(socket)).toMatchObject({
      type: 'exchange.close',
      reason: 'failed',
    });
    const id = createProxyExchangeId('cancelled');
    frame(socket, open(id));
    await nextFrame(socket);
    frame(socket, { version: 2, type: 'exchange.close', exchangeId: id });
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
  });

  it('resolves each connection, drops exchanges on reconnect, and closes handler once', async () => {
    const { server, url } = await createServer();
    const requests: Array<{ authorization: string; url: string }> = [];
    let attempt = 0;
    server.on('connection', (_socket, request) =>
      requests.push({
        authorization: String(request.headers.authorization),
        url: request.url ?? '',
      }),
    );
    const handler = {
      fetch: async () => new Response(new ReadableStream({ start() {} })),
      close: vi.fn(async () => undefined),
    };
    const connection = vi.fn(async () => ({
      url: new URL(`?ticket=ticket-${++attempt}`, url),
      headers: { authorization: `Bearer token-${attempt}` },
    }));
    const active = createProxyDaemon({
      connection,
      handler,
      reconnect: { initialDelayMs: 5, maximumDelayMs: 5, jitter: 0 },
    });
    resources.push(() => active.close());
    const accepted = once(server, 'connection');
    await active.start();
    const [socket] = (await accepted) as [WebSocket];
    frame(socket, open(createProxyExchangeId('stale')));
    await nextFrame(socket);
    socket.terminate();
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(connection).toHaveBeenCalledTimes(2);
    expect(requests).toEqual([
      {
        authorization: 'Bearer token-1',
        url: '/environment?ticket=ticket-1',
      },
      {
        authorization: 'Bearer token-2',
        url: '/environment?ticket=ticket-2',
      },
    ]);
    expect(active.activeExchangeCount).toBe(0);
    await active.close();
    await active.close();
    expect(handler.close).toHaveBeenCalledOnce();
  });

  it('rejects invalid connection URLs and closes during reconnect backoff', async () => {
    const { server, url } = await createServer();
    const handler = {
      fetch: async () => new Response(),
      close: vi.fn(async () => undefined),
    };
    const malformed = createProxyDaemon({
      connection: () => ({ url: 'not a url' }),
      handler,
    });
    await expect(malformed.start()).rejects.toThrow('Invalid URL');
    await malformed.close();

    const unsupported = createProxyDaemon({
      connection: () => ({ url: 'https://proxy.example.com/environment' }),
      handler,
    });
    await expect(unsupported.start()).rejects.toThrow('ws: or wss:');
    await unsupported.close();

    const accepted = once(server, 'connection');
    const active = createProxyDaemon({
      connection: () => ({ url }),
      handler: {
        fetch: async () => new Response(),
        close: async () => undefined,
      },
      reconnect: { initialDelayMs: 10_000, maximumDelayMs: 10_000, jitter: 0 },
    });
    const started = active.start();
    const [socket] = (await accepted) as [WebSocket];
    await started;
    socket.terminate();
    await vi.waitFor(() => expect(active.state).toBe('reconnecting'));
    await active.close();
    expect(active.state).toBe('closed');
  });
});
