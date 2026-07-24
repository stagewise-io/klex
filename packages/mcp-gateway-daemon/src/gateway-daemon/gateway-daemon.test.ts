import { once } from 'node:events';

import { McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';

import {
  createGatewaySessionId,
  decodeEnvironmentToGatewayFrame,
  encodeGatewayFrame,
  GATEWAY_PROTOCOL_VERSION,
  type GatewayToEnvironmentFrame,
} from '@stagewise/mcp-gateway-core';

import {
  createGatewayDaemon,
  type GatewayDaemon,
  type GatewayDaemonOptions,
} from './gateway-daemon';

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

function frame(socket: WebSocket, value: GatewayToEnvironmentFrame): void {
  socket.send(encodeGatewayFrame(value));
}

async function nextFrame(socket: WebSocket) {
  const [data] = await once(socket, 'message');
  return decodeEnvironmentToGatewayFrame(data.toString());
}

function daemon(
  url: URL,
  createServerFactory: GatewayDaemonOptions['createServer'] = () =>
    new McpServer({ name: 'test', version: '1' }),
) {
  const value = createGatewayDaemon({
    gatewayUrl: url,
    credential: { type: 'bearer', token: 'secret' },
    createServer: createServerFactory,
    reconnect: { initialDelayMs: 5, maximumDelayMs: 10, jitter: 0 },
  });
  resources.push(() => value.close());
  return value;
}

describe('GatewayDaemon', () => {
  it('authenticates, opens isolated servers, and closes a selected session', async () => {
    const { server, url } = await createServer();
    const requests: string[] = [];
    server.on('connection', (_socket, request) =>
      requests.push(String(request.headers.authorization)),
    );
    const accepted = once(server, 'connection');
    const created = vi.fn(() => new McpServer({ name: 'test', version: '1' }));
    const active = daemon(url, created);
    await active.start();
    const [socket] = (await accepted) as [WebSocket];
    const first = createGatewaySessionId('first');
    const second = createGatewaySessionId('second');
    frame(socket, {
      version: GATEWAY_PROTOCOL_VERSION,
      type: 'session.open',
      sessionId: first,
    });
    expect(await nextFrame(socket)).toMatchObject({
      type: 'session.opened',
      sessionId: first,
    });
    frame(socket, {
      version: GATEWAY_PROTOCOL_VERSION,
      type: 'session.open',
      sessionId: second,
    });
    expect(await nextFrame(socket)).toMatchObject({
      type: 'session.opened',
      sessionId: second,
    });
    expect(active.activeSessionCount).toBe(2);
    expect(created).toHaveBeenCalledTimes(2);
    frame(socket, {
      version: GATEWAY_PROTOCOL_VERSION,
      type: 'session.close',
      sessionId: first,
    });
    expect(await nextFrame(socket)).toMatchObject({
      type: 'session.close',
      sessionId: first,
    });
    expect(active.activeSessionCount).toBe(1);
    expect(requests).toEqual(['Bearer secret']);
  });

  it('isolates a server factory failure', async () => {
    const { server, url } = await createServer();
    const accepted = once(server, 'connection');
    const active = daemon(url, ({ sessionId }) => {
      if (sessionId === 'bad') throw new Error('private detail');
      return new McpServer({ name: 'test', version: '1' });
    });
    await active.start();
    const [socket] = (await accepted) as [WebSocket];
    frame(socket, {
      version: 1,
      type: 'session.open',
      sessionId: createGatewaySessionId('bad'),
    });
    expect(await nextFrame(socket)).toMatchObject({
      type: 'session.close',
      reason: 'Failed to create MCP session',
    });
    frame(socket, {
      version: 1,
      type: 'session.open',
      sessionId: createGatewaySessionId('good'),
    });
    expect(await nextFrame(socket)).toMatchObject({
      type: 'session.opened',
      sessionId: 'good',
    });
  });

  it('refreshes authorization and drops stale sessions on reconnect', async () => {
    const { server, url } = await createServer();
    const headers: string[] = [];
    let token = 0;
    server.on('connection', (_socket, request) =>
      headers.push(String(request.headers.authorization)),
    );
    const active: GatewayDaemon = createGatewayDaemon({
      gatewayUrl: url,
      credential: async () => `Bearer token-${++token}`,
      createServer: () => new McpServer({ name: 'test', version: '1' }),
      reconnect: { initialDelayMs: 5, maximumDelayMs: 5, jitter: 0 },
    });
    resources.push(() => active.close());
    const firstAccepted = once(server, 'connection');
    await active.start();
    const [first] = (await firstAccepted) as [WebSocket];
    frame(first, {
      version: 1,
      type: 'session.open',
      sessionId: createGatewaySessionId('stale'),
    });
    await nextFrame(first);
    first.terminate();
    await vi.waitFor(() => expect(headers).toHaveLength(2));
    expect(headers).toEqual(['Bearer token-1', 'Bearer token-2']);
    expect(active.state).toBe('connected');
    expect(active.activeSessionCount).toBe(0);
  });

  it('rejects invalid credentials without opening a socket', async () => {
    const { server, url } = await createServer();
    const connections = vi.fn();
    server.on('connection', connections);
    const active = createGatewayDaemon({
      gatewayUrl: url,
      credential: { type: 'bearer', token: '' },
      createServer: () => new McpServer({ name: 'test', version: '1' }),
    });
    resources.push(() => active.close());
    await expect(active.start()).rejects.toThrow('non-empty Bearer');
    expect(connections).not.toHaveBeenCalled();
  });

  it('closes during reconnect backoff without leaking a retry', async () => {
    const { server, url } = await createServer();
    const accepted = once(server, 'connection');
    const active = createGatewayDaemon({
      gatewayUrl: url,
      credential: { type: 'bearer', token: 'secret' },
      createServer: () => new McpServer({ name: 'test', version: '1' }),
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
