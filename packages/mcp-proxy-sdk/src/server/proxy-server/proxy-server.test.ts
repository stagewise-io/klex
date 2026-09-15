import { once } from 'node:events';

import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { createEnvironmentId } from '../../core/index.js';
import { createProxyServer } from './proxy-server';

function server() {
  return createProxyServer({
    authenticateEnvironment: async () => undefined,
    parseEnvironmentId: createEnvironmentId,
  });
}

describe('ProxyServer', () => {
  it('starts and closes idempotently', async () => {
    const active = server();
    const first = await active.start();
    const second = await active.start();
    expect(second).toBe(first);
    expect(first.mcpUrl('target').pathname).toBe('/environments/target/mcp');
    expect(first.environmentUrl.protocol).toBe('ws:');
    await active.close();
    await active.close();
  });

  it('reports configured public routes', async () => {
    const active = createProxyServer({
      authenticateEnvironment: async () => undefined,
      environmentWebSocketPath: '/machine-connections',
      parseEnvironmentId: createEnvironmentId,
      routePrefix: '/machines/',
    });
    const address = await active.start();

    expect(address.environmentUrl.pathname).toBe('/machine-connections');
    expect(address.mcpUrl('target').pathname).toBe('/machines/target/mcp');

    await active.close();
  });

  it('serves liveness and readiness endpoints', async () => {
    const active = server();
    const address = await active.start();

    for (const path of ['/health', '/ready']) {
      const response = await fetch(`${address.origin}${path}`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ status: 'ok' });
    }

    await active.close();
  });

  it('authenticates and registers environment IDs', async () => {
    const environmentId = createEnvironmentId('environment');
    let connectedEnvironmentId: string | undefined;
    const active = createProxyServer({
      authenticateEnvironment: ({ request }) =>
        request.headers.authorization === 'Bearer environment-token'
          ? environmentId
          : undefined,
      onConnected: (details) => {
        connectedEnvironmentId = details.environmentId;
      },
      parseEnvironmentId: createEnvironmentId,
    });
    const address = await active.start();

    const unauthorized = new WebSocket(address.environmentUrl);
    const [, response] = await once(unauthorized, 'unexpected-response');
    expect(response.statusCode).toBe(401);

    const authorized = new WebSocket(address.environmentUrl, {
      headers: { authorization: 'Bearer environment-token' },
    });
    await once(authorized, 'open');
    expect(connectedEnvironmentId).toBe(environmentId);

    authorized.close();
    await active.close();
  });

  it('awaits lifecycle hooks and reports the same connection on disconnect', async () => {
    const environmentId = createEnvironmentId('environment');
    let connectedConnection: object | undefined;
    let disconnectedConnection: object | undefined;
    let releaseDisconnect: (() => void) | undefined;
    const disconnectPending = new Promise<void>((resolve) => {
      releaseDisconnect = resolve;
    });
    const active = createProxyServer({
      authenticateEnvironment: async () => environmentId,
      onConnected: async ({ connection }) => {
        await Promise.resolve();
        connectedConnection = connection;
      },
      onDisconnected: async ({ connection }) => {
        disconnectedConnection = connection;
        await disconnectPending;
      },
      parseEnvironmentId: createEnvironmentId,
    });
    const address = await active.start();
    const environment = new WebSocket(address.environmentUrl);
    await once(environment, 'open');
    await vi.waitFor(() => expect(connectedConnection).toBeDefined());

    environment.close();
    await once(environment, 'close');
    const closing = active.close();
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await vi.waitFor(() => expect(disconnectedConnection).toBeDefined());
    expect(closed).toBe(false);
    expect(disconnectedConnection).toBe(connectedConnection);
    releaseDisconnect?.();
    await closing;
  });

  it('closes a connection whose setup hook rejects', async () => {
    const disconnected = vi.fn();
    const active = createProxyServer({
      authenticateEnvironment: async () => createEnvironmentId('environment'),
      onConnected: async () => {
        throw new Error('registration failed');
      },
      onDisconnected: disconnected,
      parseEnvironmentId: createEnvironmentId,
    });
    const address = await active.start();
    const environment = new WebSocket(address.environmentUrl);
    await once(environment, 'open');
    await once(environment, 'close');

    expect(disconnected).not.toHaveBeenCalled();
    await active.close();
  });

  it('allows close before start', async () => {
    const active = server();
    await active.close();
    await active.close();
    await expect(active.start()).rejects.toThrow('closed');
  });
});
