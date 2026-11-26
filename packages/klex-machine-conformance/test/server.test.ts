import { createServer } from 'node:net';

import { describe, expect, it } from 'vitest';

import { PUSH, startMachine, windows } from '../src/harness.js';

describe('HTTP server', () => {
  it('serves health on GET and HEAD and 404s other routes', async () => {
    const machine = await startMachine();
    const health = await fetch(`${machine.origin}/health`);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({
      status: 'ok',
      service: 'klex-machine',
    });
    const head = await fetch(`${machine.origin}/health`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    const missing = await fetch(`${machine.origin}/nope`);
    expect(missing.status).toBe(404);
    await expect(missing.text()).resolves.toBe('404 Not Found');
    const post = await fetch(`${machine.origin}/health`, { method: 'POST' });
    expect(post.status).toBe(404);
  });

  it('logs startup details as tslog-shaped JSON', async () => {
    const machine = await startMachine();
    const listening = machine.logs.find(
      (record) => record.message === 'klex-machine MCP server listening',
    );
    expect(listening).toMatchObject({
      level: 'INFO',
      levelId: 3,
      cwd: machine.cwd,
      host: '127.0.0.1',
      port: machine.port,
      _logMeta: { name: 'klex-machine', logLevelName: 'INFO' },
    });
  });

  it('rejects malformed JSON before MCP handling', async () => {
    const machine = await startMachine();
    const response = await fetch(machine.url, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: '{broken',
    });
    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toBe('Invalid JSON');
  });

  it.each([
    ['evil.example', 'Invalid Host: evil.example'],
    ['evil.example:80', 'Invalid Host: evil.example'],
  ])('rejects DNS-rebinding Host %s on loopback', async (host, message) => {
    const machine = await startMachine();
    const response = await rawRequest(machine.port, {
      host,
      body: initializeBody(),
    });
    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toEqual({
      jsonrpc: '2.0',
      error: { code: -32000, message },
      id: null,
    });
  });

  it('rejects cross-origin browser requests on loopback', async () => {
    const machine = await startMachine();
    const response = await fetch(machine.url, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        origin: 'https://evil.example',
      },
      body: initializeBody(),
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Invalid Origin: evil.example' },
      id: null,
    });
    const allowed = await fetch(machine.url, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        origin: `http://localhost:${machine.port}`,
      },
      body: initializeBody(),
    });
    expect(allowed.status).toBe(200);
  });

  it('protects push subscriptions with the same Host check', async () => {
    const machine = await startMachine();
    const response = await rawRequest(machine.port, {
      host: 'evil.example',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'subscriptions/listen',
        params: {
          notifications: { [PUSH]: {} },
          _meta: machine.meta(true),
        },
      }),
    });
    expect(response.status).toBe(403);
  });

  it('fails startup with a clear error when the port is taken', async () => {
    const occupied = createServer();
    await new Promise<void>((done) => occupied.listen(0, '127.0.0.1', done));
    const address = occupied.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    try {
      await expect(
        startMachine({ args: ['--port', String(address.port)] }),
      ).rejects.toThrow(
        `listen EADDRINUSE: address already in use 127.0.0.1:${address.port}`,
      );
    } finally {
      await new Promise<void>((done) => occupied.close(() => done()));
    }
  });

  it.skipIf(windows)(
    'shuts down gracefully on SIGTERM with an open push subscription',
    async () => {
      const machine = await startMachine();
      const abort = new AbortController();
      const response = await machine.post(
        'subscriptions/listen',
        { notifications: { [PUSH]: {} } },
        { push: true, signal: abort.signal },
      );
      expect(response.headers.get('content-type')).toContain(
        'text/event-stream',
      );
      const reader = response.body?.getReader();
      try {
        const first = await reader?.read();
        expect(new TextDecoder().decode(first?.value)).toContain(
          'notifications/subscriptions/acknowledged',
        );
        const exit = await machine.stop('SIGTERM');
        expect(exit).toEqual({ code: 0, signal: null });
        expect(
          machine.logs.some(
            (record) =>
              record.message === 'Shutting down klex-machine MCP server' &&
              record.signal === 'SIGTERM',
          ),
        ).toBe(true);
      } finally {
        abort.abort();
        await reader?.cancel().catch(() => undefined);
      }
    },
  );
});

function initializeBody(): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'conformance', version: '1.0.0' },
    },
  });
}

/** fetch() cannot override Host, so DNS-rebinding probes use raw HTTP. */
async function rawRequest(
  port: number,
  { host, body }: { host: string; body: string },
): Promise<{ status: number; body: string }> {
  const { request } = await import('node:http');
  return new Promise((done, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          host,
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => done({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}
