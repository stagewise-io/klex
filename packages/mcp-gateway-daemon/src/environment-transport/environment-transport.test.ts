import { describe, expect, it, vi } from 'vitest';

import { createGatewaySessionId } from '@stagewise/mcp-gateway-core';

import { createEnvironmentTransport } from './environment-transport';

const request = { jsonrpc: '2.0', id: 1, method: 'ping' } as const;

function createTransport(send = vi.fn(async () => undefined)) {
  return {
    send,
    transport: createEnvironmentTransport(createGatewaySessionId('one'), send),
  };
}

describe('EnvironmentTransport', () => {
  it('buffers before start and delivers in order only once', async () => {
    const { transport } = createTransport();
    const messages: unknown[] = [];
    transport.receive(request);
    transport.receive({ ...request, id: 2 });
    transport.onmessage = (message) => messages.push(message);
    await transport.start();
    await transport.start();
    expect(messages).toEqual([request, { ...request, id: 2 }]);
  });

  it('rejects sends before start and after close', async () => {
    const { transport } = createTransport();
    await expect(transport.send(request)).rejects.toThrow('not active');
    await transport.start();
    await transport.close();
    await expect(transport.send(request)).rejects.toThrow('not active');
  });

  it('frames sends and closes exactly once', async () => {
    const { send, transport } = createTransport();
    const closed = vi.fn();
    transport.onclose = closed;
    await transport.start();
    await transport.send(request, { relatedRequestId: 1 });
    expect(send).toHaveBeenCalledWith({
      version: 1,
      type: 'session.message',
      sessionId: 'one',
      message: request,
      options: { relatedRequestId: 1 },
    });
    await transport.close();
    await transport.close();
    expect(closed).toHaveBeenCalledOnce();
  });

  it('reports outbound failure before closing', async () => {
    const order: string[] = [];
    const { transport } = createTransport(
      vi.fn(async () => {
        throw new Error('send failed');
      }),
    );
    transport.onerror = () => order.push('error');
    transport.onclose = () => order.push('close');
    await transport.start();
    await expect(transport.send(request)).rejects.toThrow('send failed');
    expect(order).toEqual(['error', 'close']);
  });
});
