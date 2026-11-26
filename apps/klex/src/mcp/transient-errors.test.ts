import { createServer, type ServerResponse } from 'node:http';

import {
  ProtocolError,
  SdkErrorCode,
  SdkHttpError,
} from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';

import { connectMcpServer } from './connection';
import {
  classifyTransientMcpError,
  McpServerStartingError,
  transientRetryDelayMs,
} from './transient-errors';

/** The JSON-RPC body Klex Cloud's mcp-proxy sends for a refused `prepare`. */
function proxyBody(
  code: string,
  message: string,
  retryAfterSeconds?: number,
): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    error: { code: -32000, message, data: { code, retryAfterSeconds } },
  });
}

function httpError(status: number, text: string): SdkHttpError {
  return new SdkHttpError(
    SdkErrorCode.ClientHttpNotImplemented,
    `Error POSTing to endpoint: ${text}`,
    { status, text },
  );
}

describe('classifyTransientMcpError', () => {
  it('reads the retry hint and code of a proxy 503', () => {
    expect(
      classifyTransientMcpError(
        httpError(
          503,
          proxyBody(
            'machine_starting',
            'Computer is starting; retry in 5 seconds',
            5,
          ),
        ),
      ),
    ).toEqual({ retryAfterMs: 5_000, code: 'machine_starting' });
  });

  it('treats any 503 as transient, including non-JSON-RPC bodies', () => {
    expect(
      classifyTransientMcpError(
        httpError(503, JSON.stringify({ error: 'Machine is not connected' })),
      ),
    ).toEqual({});
    expect(classifyTransientMcpError(httpError(503, 'upstream'))).toEqual({});
  });

  it('keeps billing denials and other 4xx responses final', () => {
    expect(
      classifyTransientMcpError(
        httpError(
          409,
          proxyBody(
            'machine_billing_suspended',
            'Managed computer billing authorization is unavailable or changed',
          ),
        ),
      ),
    ).toBeUndefined();
    expect(classifyTransientMcpError(httpError(404, ''))).toBeUndefined();
  });

  it('retries a non-503 response that carries a lifecycle hint', () => {
    expect(
      classifyTransientMcpError(
        httpError(409, proxyBody('capacity_wait', 'Waiting for capacity')),
      ),
    ).toEqual({ code: 'capacity_wait' });
    expect(
      classifyTransientMcpError(
        httpError(429, proxyBody('rate_limited', 'Slow down', 2)),
      ),
    ).toEqual({ retryAfterMs: 2_000, code: 'rate_limited' });
  });

  it('never retries authentication or authorization failures', () => {
    for (const status of [401, 403]) {
      expect(
        classifyTransientMcpError(
          httpError(status, proxyBody('machine_starting', 'Starting', 5)),
        ),
      ).toBeUndefined();
    }
  });

  it('reads hints from in-band JSON-RPC errors', () => {
    expect(
      classifyTransientMcpError(
        ProtocolError.fromError(-32000, 'Starting', {
          code: 'machine_starting',
          retryAfterSeconds: 3,
        }),
      ),
    ).toEqual({ retryAfterMs: 3_000, code: 'machine_starting' });
    expect(
      classifyTransientMcpError(
        ProtocolError.fromError(-32000, 'Denied', { code: 'forbidden' }),
      ),
    ).toBeUndefined();
    expect(classifyTransientMcpError(new Error('offline'))).toBeUndefined();
  });

  it('finds a transient failure through wrapping causes', () => {
    expect(
      classifyTransientMcpError(
        new Error('connect failed', { cause: httpError(503, '') }),
      ),
    ).toEqual({});
  });
});

describe('transientRetryDelayMs', () => {
  it('honors the server hint within bounds', () => {
    expect(transientRetryDelayMs({ retryAfterMs: 5_000 }, 1)).toBe(5_000);
    expect(transientRetryDelayMs({ retryAfterMs: 0 }, 1)).toBe(1_000);
    expect(transientRetryDelayMs({ retryAfterMs: 120_000 }, 1)).toBe(10_000);
  });

  it('backs off exponentially without a hint', () => {
    expect([1, 2, 3, 4, 5].map((n) => transientRetryDelayMs({}, n))).toEqual([
      1_000, 2_000, 4_000, 8_000, 10_000,
    ]);
  });
});

describe('McpServerStartingError', () => {
  it('tells the model to retry without billing or permission wording', () => {
    const error = new McpServerStartingError(
      'computer',
      { code: 'machine_starting', retryAfterMs: 5_000, waitedMs: 15_200 },
      new Error('billing authorization failed'),
    );
    expect(error.message).toBe(
      'MCP server "computer" is temporarily unavailable: its computer is ' +
        'starting or reconnecting. Klex retried for 15 s. This is temporary ' +
        'and does not mean the computer is broken, unpaid, or unauthorized. ' +
        'Wait about 5 s, then call the tool again.',
    );
    expect(error.code).toBe('machine_starting');
  });
});

// Pins how the SDK surfaces a refused `prepare`, which the classifier relies on.
describe('transient failures through the HTTP transport', () => {
  async function withServer(
    respond: (method: string, id: unknown, response: ServerResponse) => void,
    run: (url: string) => Promise<void>,
  ): Promise<void> {
    const server = createServer(async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        method: string;
        id?: unknown;
      };
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      respond(message.method, message.id, response);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected an IP address');
    try {
      await run(`http://127.0.0.1:${address.port}/mcp`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  function reply(response: ServerResponse, id: unknown, result: unknown) {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  }

  function refuse(response: ServerResponse, status: number, body: string) {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(body);
  }

  const options = (url: string) => ({
    namespace: 'computer',
    config: { url, versionNegotiation: 'legacy' as const },
    signal: AbortSignal.timeout(5_000),
    onToolsChanged: () => undefined,
    onDisconnect: () => undefined,
    onPushNotification: () => undefined,
    onRealtimeMediaNotification: () => undefined,
    onResourceUpdated: () => undefined,
  });

  it('classifies a 503 refusal of initialize', async () => {
    await withServer(
      (_method, _id, response) =>
        refuse(response, 503, proxyBody('machine_starting', 'Starting', 5)),
      async (url) => {
        const error = await connectMcpServer(options(url)).then(
          () => undefined,
          (failure: unknown) => failure,
        );
        expect(classifyTransientMcpError(error)).toEqual({
          retryAfterMs: 5_000,
          code: 'machine_starting',
        });
      },
    );
  });

  it('classifies a 503 refusal of tools/call and keeps a 409 final', async () => {
    const refusals = [
      [503, proxyBody('capacity_wait', 'Waiting for capacity', 5)],
      [409, proxyBody('billing_authorization_failed', 'Denied')],
    ] as const;
    let call = 0;
    await withServer(
      (method, id, response) => {
        if (method === 'initialize')
          return reply(response, id, {
            protocolVersion: '2025-11-25',
            capabilities: { tools: {} },
            serverInfo: { name: 'computer', version: '1.0.0' },
          });
        if (method === 'tools/list')
          return reply(response, id, {
            tools: [{ name: 'run', inputSchema: { type: 'object' } }],
          });
        const [status, body] = refusals[call++] ?? [500, ''];
        refuse(response, status, body);
      },
      async (url) => {
        const connection = await connectMcpServer(options(url));
        try {
          const tool = connection.tools[0];
          if (!tool) throw new Error('Expected a tool');
          const signal = AbortSignal.timeout(5_000);
          const starting = await connection
            .invoke(tool, {}, signal)
            .catch((failure: unknown) => failure);
          expect(classifyTransientMcpError(starting)).toEqual({
            retryAfterMs: 5_000,
            code: 'capacity_wait',
          });
          const denied = await connection
            .invoke(tool, {}, signal)
            .catch((failure: unknown) => failure);
          expect(denied).toBeInstanceOf(SdkHttpError);
          expect(classifyTransientMcpError(denied)).toBeUndefined();
        } finally {
          await connection.close();
        }
      },
    );
  });
});
