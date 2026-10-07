import { createServer } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { createLogger } from '@stagewise/logger';

import { createDrain } from '@/drain';

import { createHealthServer, type HealthServer } from './health-server';

const logging = createLogger({ name: 'health-test', console: false });
const servers: HealthServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function fixture() {
  const reservation = createServer();
  await new Promise<void>((resolve) =>
    reservation.listen(0, '127.0.0.1', resolve),
  );
  const address = reservation.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing address');
  const port = address.port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const server = createHealthServer({ logging, host: '127.0.0.1', port });
  servers.push(server);
  return { server, port, url: `http://127.0.0.1:${port}` };
}

describe('health server', () => {
  it('answers liveness before readiness, and readiness follows lifecycle state', async () => {
    const { server, url } = await fixture();
    await server.start();
    expect((await fetch(`${url}/livez`)).status).toBe(200);
    expect((await fetch(`${url}/readyz`)).status).toBe(503);
    server.markReady();
    const ready = await fetch(`${url}/readyz`);
    expect(ready.status).toBe(200);
    expect(await ready.text()).toBe('ok\n');
    expect(ready.headers.get('cache-control')).toBe('no-store');
    server.markNotReady();
    // Startup may finish after a termination signal. It must not re-enable readiness.
    server.markReady();
    expect((await fetch(`${url}/readyz`)).status).toBe(503);
    expect((await fetch(`${url}/livez`)).status).toBe(200);
  });

  it('stays live but not ready throughout a busy termination drain', async () => {
    const { server, url } = await fixture();
    await server.start();
    server.markReady();
    let busy = true;
    const drain = createDrain({
      logging,
      sessionHost: {
        isQuiescent: () => !busy,
        isInteractionLeased: () => false,
        beginDrain: () => undefined,
      },
      godMessages: {
        isQuiescent: () => true,
        beginDrain: () => undefined,
      },
      mcp: {
        pausePushDelivery: () => undefined,
        acknowledgeDeliveredEvents: async () => undefined,
      },
      onBegin: () => server.markNotReady(),
      pollIntervalMs: 10,
    });
    const draining = drain.drain({
      reason: 'termination',
      timeoutMs: 1_000,
      pauseWhileLeased: false,
    });
    try {
      expect((await fetch(`${url}/readyz`)).status).toBe(503);
      expect((await fetch(`${url}/livez`)).status).toBe(200);
    } finally {
      busy = false;
      await draining;
    }
    expect((await fetch(`${url}/readyz`)).status).toBe(503);
  });

  it('exposes only the exact GET probe routes', async () => {
    const { server, url } = await fixture();
    await server.start();
    for (const path of ['/v1/health', '/', '/livez?x=1', '/readyz/']) {
      expect((await fetch(`${url}${path}`)).status).toBe(404);
    }
    for (const method of ['POST', 'HEAD', 'DELETE']) {
      expect((await fetch(`${url}/livez`, { method })).status).toBe(404);
    }
  });

  it('starts and closes idempotently, releasing the port', async () => {
    const { server, url } = await fixture();
    await server.close();
    await Promise.all([server.start(), server.start()]);
    await Promise.all([server.close(), server.close()]);
    await expect(fetch(`${url}/livez`)).rejects.toThrow();
  });

  it('propagates a bind failure and closes safely after failed startup', async () => {
    const first = await fixture();
    await first.server.start();
    const second = createHealthServer({
      logging,
      host: '127.0.0.1',
      port: first.port,
    });
    servers.push(second);
    await expect(second.start()).rejects.toMatchObject({ code: 'EADDRINUSE' });
    await expect(second.close()).resolves.toBeUndefined();
    expect((await fetch(`${first.url}/livez`)).status).toBe(200);
  });

  it('closes safely while startup is in progress', async () => {
    const { server, url } = await fixture();
    const starting = server.start();
    await server.close();
    await starting;
    await expect(fetch(`${url}/livez`)).rejects.toThrow();
  });
});
