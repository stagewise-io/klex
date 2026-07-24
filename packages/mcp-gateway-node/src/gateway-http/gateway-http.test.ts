import { describe, expect, it, vi } from 'vitest';

import type {
  Gateway,
  GatewayMessage,
  GatewayMessageOptions,
  GatewaySession,
  Unsubscribe,
} from '@stagewise/mcp-gateway-core';
import {
  createAgentId,
  createEnvironmentId,
  createGatewaySessionId,
  createTenantId,
} from '@stagewise/mcp-gateway-core';

import { createGatewayHttp } from './gateway-http';

class FakeSession implements GatewaySession {
  readonly id = createGatewaySessionId('gateway-session');
  readonly sent: GatewayMessage[] = [];
  readonly messageHandlers = new Set<
    (message: GatewayMessage, options?: GatewayMessageOptions) => void
  >();
  readonly closeHandlers = new Set<(cause?: Error) => void>();
  send = vi.fn(async (message: GatewayMessage) => {
    this.sent.push(message);
    if ('id' in message && message.id !== undefined) {
      const id = message.id;
      queueMicrotask(() =>
        this.emit({
          jsonrpc: '2.0',
          id,
          result:
            'method' in message && message.method === 'initialize'
              ? {
                  protocolVersion: '2025-06-18',
                  capabilities: {},
                  serverInfo: { name: 'fake', version: '1.0.0' },
                }
              : {},
        }),
      );
    }
  });
  close = vi.fn(async () => {
    for (const handler of this.closeHandlers) handler();
  });
  onMessage(
    handler: (message: GatewayMessage, options?: GatewayMessageOptions) => void,
  ): Unsubscribe {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }
  onClose(handler: (cause?: Error) => void): Unsubscribe {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }
  emit(message: GatewayMessage, options?: GatewayMessageOptions) {
    for (const handler of this.messageHandlers) handler(message, options);
  }
}

const tenantId = createTenantId('tenant');
const agent = {
  kind: 'agent' as const,
  tenantId,
  agentId: createAgentId('agent'),
};

function setup(authenticated = true) {
  const session = new FakeSession();
  const gateway = {
    openSession: vi.fn(async () => session),
    registerEnvironment: vi.fn(),
    close: vi.fn(),
  } as unknown as Gateway;
  return {
    session,
    gateway,
    handler: createGatewayHttp({
      gateway,
      authenticateAgent: async () => (authenticated ? agent : undefined),
      parseEnvironmentId: (value) => createEnvironmentId(value),
    }),
  };
}

function initialize() {
  return new Request('http://test/environments/environment/mcp', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    }),
  });
}

describe('GatewayHttp', () => {
  it('rejects unknown routes and unauthenticated requests', async () => {
    const active = setup(false);
    expect(
      (await active.handler.fetch(new Request('http://test/mcp'))).status,
    ).toBe(404);
    expect((await active.handler.fetch(initialize())).status).toBe(401);
    expect(active.gateway.openSession).not.toHaveBeenCalled();
  });

  it('initializes and terminates a legacy session', async () => {
    const active = setup();
    const response = await active.handler.fetch(initialize());
    expect(response.status).toBe(200);
    const id = response.headers.get('mcp-session-id');
    expect(id).toBeTruthy();
    if (!id) throw new Error('Expected session ID');
    const deleted = await active.handler.fetch(
      new Request('http://test/environments/environment/mcp', {
        method: 'DELETE',
        headers: { 'mcp-session-id': id },
      }),
    );
    expect(deleted.status).toBe(200);
    expect(active.session.close).toHaveBeenCalledOnce();
  });

  it('closes active resources idempotently', async () => {
    const active = setup();
    await active.handler.fetch(initialize());
    await active.handler.close();
    await active.handler.close();
    expect(active.handler.sessionCount).toBe(0);
    expect(active.session.close).toHaveBeenCalledOnce();
  });
});
