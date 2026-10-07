import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { withPushNotificationsClientCapability } from '@stagewise/mcp-extension-push-notifications';

import type { RuntimeConfig } from '../src/config.js';
import * as machineMcp from '../src/mcp.js';
import { createNotificationStore } from '../src/notifications/index.js';
import {
  createMachineApp,
  type MachineServer,
  startMachineServer,
} from '../src/server.js';
import { WorkloadTracker } from '../src/workloads/index.js';

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

function fakeMcp(): machineMcp.MachineMcp & {
  close: ReturnType<typeof vi.fn>;
} {
  return {
    workloads: new WorkloadTracker(),
    fetch: vi.fn(async () => new Response('mcp-response')),
    close: vi.fn(async () => undefined),
  };
}

const logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};
const running: MachineServer[] = [];

afterEach(async () => {
  try {
    await Promise.all(running.splice(0).map((server) => server.close()));
  } finally {
    vi.restoreAllMocks();
  }
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

  it('closes the listener while a push subscription is active', async () => {
    const server = await startMachineServer(config(), {
      logger,
      registerSignals: false,
    });
    running.push(server);
    const response = await fetch(`http://${server.host}:${server.port}/mcp`, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'subscriptions/listen',
        params: {
          notifications: { 'io.stagewise/push-notifications': {} },
          _meta: withPushNotificationsClientCapability({}),
        },
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Missing subscription stream');
    try {
      const first = await reader.read();
      expect(first.done).toBe(false);
      expect(new TextDecoder().decode(first.value)).toContain(
        'notifications/subscriptions/acknowledged',
      );
      await server.close();
      running.splice(running.indexOf(server), 1);
    } finally {
      await reader.cancel();
    }
  });

  it.each([false, true])(
    'releases the notification lock even when MCP cleanup fails, startup=%s',
    async (startup) => {
      const dataDir = await mkdtemp(join(tmpdir(), 'machine shutdown '));
      const occupied = createServer();
      const mcp = fakeMcp();
      const failure = new Error('MCP cleanup failed');
      mcp.close.mockRejectedValueOnce(failure);
      vi.spyOn(machineMcp, 'createMachineMcp').mockReturnValueOnce(mcp);
      try {
        let port = 0;
        if (startup) {
          await new Promise<void>((resolve) =>
            occupied.listen(0, '127.0.0.1', resolve),
          );
          const address = occupied.address();
          if (!address || typeof address === 'string')
            throw new Error('Missing address');
          port = address.port;
          await expect(
            startMachineServer(config({ port }), {
              dataDir,
              logger,
              registerSignals: false,
            }),
          ).rejects.toBe(failure);
        } else {
          const server = await startMachineServer(config(), {
            dataDir,
            logger,
            registerSignals: false,
          });
          await expect(server.close()).rejects.toBe(failure);
        }
        expect(mcp.close).toHaveBeenCalledOnce();
        const reopened = createNotificationStore({ dataDir, logger });
        try {
          await reopened.ready();
          expect(reopened.persistent).toBe(true);
        } finally {
          await reopened.close();
        }
      } finally {
        if (occupied.listening)
          await new Promise<void>((resolve, reject) =>
            occupied.close((error) => (error ? reject(error) : resolve())),
          );
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  );
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
