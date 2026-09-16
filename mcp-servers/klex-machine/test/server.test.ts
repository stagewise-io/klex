import { createServer } from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeConfig } from '../src/config.js';
import type { MachineMcp } from '../src/mcp.js';
import {
  createMachineApp,
  type MachineServer,
  startMachineServer,
} from '../src/server.js';

function config(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    cwd: process.cwd(),
    host: '127.0.0.1',
    port: 0,
    logLevel: 'fatal',
    warnsAboutRemoteAccess: false,
    ...overrides,
  };
}

function fakeMcp(): MachineMcp & { close: ReturnType<typeof vi.fn> } {
  return {
    fetch: vi.fn(async () => new Response('mcp-response')),
    close: vi.fn(async () => undefined),
  };
}

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};
const running: MachineServer[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
});

describe('machine HTTP server', () => {
  it('serves health and delegates the MCP route', async () => {
    const mcp = fakeMcp();
    const app = createMachineApp(mcp);

    const health = await app.request('http://127.0.0.1/health', {
      headers: { Host: '127.0.0.1' },
    });
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({
      status: 'ok',
      service: 'klex-machine',
    });

    const response = await app.request('http://127.0.0.1/mcp', {
      method: 'POST',
      headers: { Host: '127.0.0.1' },
    });
    expect(await response.text()).toBe('mcp-response');
    expect(mcp.fetch).toHaveBeenCalledOnce();
  });

  it('binds the configured host and supports idempotent ordered shutdown', async () => {
    const mcp = fakeMcp();
    const server = await startMachineServer(config(), {
      logger,
      mcp,
      registerSignals: false,
    });
    running.push(server);

    expect(server.host).toBe('127.0.0.1');
    expect(server.port).toBeGreaterThan(0);
    const health = await fetch(`http://${server.host}:${server.port}/health`);
    expect(health.status).toBe(200);

    await Promise.all([server.close(), server.close()]);
    running.splice(running.indexOf(server), 1);
    expect(mcp.close).toHaveBeenCalledOnce();
  });

  it('closes MCP state when listener startup fails', async () => {
    const occupied = createServer();
    await new Promise<void>((resolve) =>
      occupied.listen(0, '127.0.0.1', resolve),
    );
    const address = occupied.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing address');
    const mcp = fakeMcp();

    await expect(
      startMachineServer(config({ port: address.port }), {
        logger,
        mcp,
        registerSignals: false,
      }),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(mcp.close).toHaveBeenCalledOnce();
    await new Promise<void>((resolve, reject) =>
      occupied.close((error) => (error ? reject(error) : resolve())),
    );
  });
});
