import type { AddressInfo } from 'node:net';

import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

import { WebSocketTransport } from './websocket-transport.js';

describe('WebSocketTransport', () => {
  let wss: WebSocketServer;
  let serverWs: WebSocket;
  let clientWs: WebSocket;
  let serverTransport: WebSocketTransport;
  let clientTransport: WebSocketTransport;

  beforeEach(async () => {
    await new Promise<void>((resolve) => {
      wss = new WebSocketServer({ port: 0 }, resolve);
    });

    const port = (wss.address() as AddressInfo).port;

    wss.on('connection', (ws) => {
      serverWs = ws;
    });

    clientWs = new WebSocket(`ws://localhost:${port}`);
    await new Promise<void>((resolve, reject) => {
      clientWs.once('open', resolve);
      clientWs.once('error', reject);
    });

    // Wait for the server-side connection to be captured
    await new Promise<void>((resolve) => {
      if (serverWs) return resolve();
      wss.once('connection', () => resolve());
    });

    serverTransport = new WebSocketTransport(serverWs);
    clientTransport = new WebSocketTransport(clientWs);
  });

  afterEach(async () => {
    try {
      await serverTransport?.close();
    } catch {
      // ignore
    }
    try {
      await clientTransport?.close();
    } catch {
      // ignore
    }
    wss?.close();
    // Wait for all connections to close
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  });

  it('should wire up message handlers on start()', async () => {
    let received: JSONRPCMessage | null = null;
    serverTransport.onmessage = (msg) => {
      received = msg;
    };

    await serverTransport.start();
    await clientTransport.start();

    const testMessage: JSONRPCMessage = {
      jsonrpc: '2.0',
      method: 'test',
      id: 1,
    };

    await clientTransport.send(testMessage);

    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(received).toEqual(testMessage);
  });

  it('should send JSON-RPC messages as correct JSON', async () => {
    await serverTransport.start();

    let raw: string | null = null;
    serverWs.on('message', (data: Buffer) => {
      raw = data.toString();
    });

    const testMessage: JSONRPCMessage = {
      jsonrpc: '2.0',
      method: 'tools/list',
      id: 42,
    };

    await clientTransport.send(testMessage);

    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(raw).toBe(JSON.stringify(testMessage));
  });

  it('should fire onmessage when the other end sends a message', async () => {
    let received: JSONRPCMessage | null = null;
    clientTransport.onmessage = (msg) => {
      received = msg;
    };

    await serverTransport.start();
    await clientTransport.start();

    const testMessage: JSONRPCMessage = {
      jsonrpc: '2.0',
      result: { tools: [] },
      id: 1,
    };

    await serverTransport.send(testMessage);

    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(received).toEqual(testMessage);
  });

  it('should fire onclose when the connection is closed', async () => {
    let closed = false;
    clientTransport.onclose = () => {
      closed = true;
    };

    await serverTransport.start();
    await clientTransport.start();

    await serverTransport.close();

    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(closed).toBe(true);
  });

  it('should throw when sending on a closed WebSocket', async () => {
    await serverTransport.start();
    await clientTransport.start();

    await clientTransport.close();

    // Wait for close to propagate
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    await expect(
      clientTransport.send({ jsonrpc: '2.0', method: 'test', id: 1 }),
    ).rejects.toThrow('WebSocket is not open');
  });
});
