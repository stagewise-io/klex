import { once } from 'node:events';

import { describe, expect, it } from 'vitest';
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

  it('allows close before start', async () => {
    const active = server();
    await active.close();
    await active.close();
    await expect(active.start()).rejects.toThrow('closed');
  });
});
