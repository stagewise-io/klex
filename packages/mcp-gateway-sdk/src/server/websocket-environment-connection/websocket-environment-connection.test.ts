import { once } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';

import {
  createGatewayExchangeId,
  encodeGatewayFrame,
  GATEWAY_PROTOCOL_VERSION,
} from '../../core/index.js';
import { createWebSocketEnvironmentConnection } from './websocket-environment-connection';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () =>
  Promise.allSettled(cleanup.splice(0).map((close) => close())),
);

async function pair() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (typeof address === 'string' || address === null)
    throw new Error('No port');
  const accepted = once(server, 'connection');
  const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
  const [socket] = (await accepted) as [WebSocket];
  await once(client, 'open');
  cleanup.push(async () => {
    client.terminate();
    for (const peer of server.clients) peer.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { client, connection: createWebSocketEnvironmentConnection(socket) };
}

const exchangeId = createGatewayExchangeId('exchange-1');

describe('WebSocketEnvironmentConnection', () => {
  it('decodes frames in order and closes once', async () => {
    const active = await pair();
    const frames: string[] = [];
    const closed = vi.fn();
    active.connection.onFrame((frame) => frames.push(frame.type));
    active.connection.onClose(closed);
    active.client.send(
      encodeGatewayFrame({
        version: 2,
        type: 'exchange.opened',
        exchangeId,
        status: 200,
        statusText: 'OK',
        headers: {},
      }),
    );
    active.client.send(
      encodeGatewayFrame({ version: 2, type: 'exchange.close', exchangeId }),
    );
    await vi.waitFor(() =>
      expect(frames).toEqual(['exchange.opened', 'exchange.close']),
    );
    await active.connection.close();
    await active.connection.close();
    expect(closed).toHaveBeenCalledOnce();
  });

  it.each([
    ['invalid text', () => 'not json'],
    ['binary data', () => Buffer.from('invalid')],
  ])('rejects %s', async (_name, payload) => {
    const active = await pair();
    const closed = vi.fn();
    active.connection.onClose(closed);
    active.client.send(payload());
    await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
    await expect(
      active.connection.send({
        version: GATEWAY_PROTOCOL_VERSION,
        type: 'exchange.open',
        exchangeId,
        method: 'POST',
        url: 'https://environment.invalid/mcp',
        headers: {},
      }),
    ).rejects.toThrow('closed');
  });

  it('notifies remote closure exactly once', async () => {
    const active = await pair();
    const closed = vi.fn();
    active.connection.onClose(closed);
    active.client.close();
    await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
    await active.connection.close();
    expect(closed).toHaveBeenCalledOnce();
  });
});
