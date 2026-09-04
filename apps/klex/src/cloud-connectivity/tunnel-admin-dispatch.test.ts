/**
 * Proves that the MCP authorization admin routes are reachable over a real tunnel
 * WebSocket, framed exactly the way Klex Cloud frames them.
 *
 * The contract verified here is what the production wiring depends on: a
 * request arriving as REQUEST_HEAD/REQUEST_DATA/REQUEST_END frames reaches the
 * admin app with path and body intact, and its response travels back as
 * RESPONSE_HEAD/RESPONSE_DATA/RESPONSE_END.
 */
import {
  AgentTunnelConnection,
  type DecodedFrame,
  decodeFrame,
  decodeMessage,
  encodeMessageFrame,
  HttpMethod,
  MessageType,
} from '@klex/cloud-api';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

import type { ModuleLogger } from '@stagewise/logger';

import type { Config } from '@/config';
import type { Mcp, McpServerInfo } from '@/mcp';

import {
  getMcpServers,
  getMcpServersRoute,
  type McpRouteDependencies,
} from '../admin-api/routes/v1/mcp';
import {
  completeAuthorization,
  completeAuthorizationRoute,
  type McpAuthorizationRouteDependencies,
} from '../admin-api/routes/v1/mcp.authorization';
import { setupTestApp } from '../admin-api/routes/v1/test-utils';

const logger = {
  info: () => undefined,
  error: () => undefined,
} as unknown as ModuleLogger;

const authorizingServer: McpServerInfo = {
  name: 'qonto',
  status: 'authorizing',
  toolCount: 0,
  supportsPushNotifications: false,
  supportsRealtimeMedia: false,
  transport: 'http',
  usesInteractiveOAuth: true,
  authorization: {
    id: 'auth-1',
    createdAt: '2026-07-28T08:00:00.000Z',
    expiresAt: '2026-07-28T08:15:00.000Z',
  },
  lastError: null,
  nextRetryAt: null,
};

/** Control frames (WELCOME, PING/PONG) use stream id 0. */
const CONTROL_STREAM_ID = 0;

interface TunneledResponse {
  status: number;
  headers: Record<string, string | string[]>;
  body: string;
}

/**
 * Server-side view of one tunnel connection: sends request frames the way the
 * cloud tunnel session does and reassembles the agent's response frames.
 */
class TunnelPeer {
  private chunks: Buffer[] = [];
  private resolveResponse?: (response: TunneledResponse) => void;
  private rejectResponse?: (error: Error) => void;
  private head?: { status: number; headers: Record<string, string | string[]> };

  constructor(private readonly ws: WebSocket) {
    ws.on('message', (data: Buffer) => {
      this.handleFrame(decodeFrame(data));
    });
    // Without these the socket dying mid-request would surface as an opaque
    // vitest timeout instead of the actual failure.
    ws.on('error', (error) => this.fail(error));
    ws.on('close', () =>
      this.fail(new Error('tunnel socket closed before RESPONSE_END')),
    );
  }

  /** WELCOME must be the first frame, per the protocol. */
  public welcome(): void {
    this.ws.send(
      encodeMessageFrame(
        {
          type: MessageType.WELCOME,
          protocolVersion: 1,
          startTime: Math.floor(Date.now() / 1000),
          agentId: 'agent-under-test',
        },
        CONTROL_STREAM_ID,
      ),
    );
  }

  public request(
    streamId: number,
    method: number,
    path: string,
    body?: string,
  ): Promise<TunneledResponse> {
    this.chunks = [];
    this.head = undefined;
    const response = new Promise<TunneledResponse>((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(new Error('no tunneled response within 5s')),
        5_000,
      );
      timer.unref?.();
      this.resolveResponse = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
      this.rejectResponse = (error) => {
        clearTimeout(timer);
        reject(error);
      };
    });

    const headers: Record<string, string> = { host: 'agent' };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(body));
    }

    this.ws.send(
      encodeMessageFrame(
        { type: MessageType.REQUEST_HEAD, method, path, headers },
        streamId,
      ),
    );

    if (body !== undefined) {
      this.ws.send(
        encodeMessageFrame(
          { type: MessageType.REQUEST_DATA, data: Buffer.from(body, 'utf8') },
          streamId,
        ),
      );
    }

    this.ws.send(
      encodeMessageFrame({ type: MessageType.REQUEST_END }, streamId),
    );

    return response;
  }

  private fail(error: Error): void {
    const reject = this.rejectResponse;
    this.resolveResponse = undefined;
    this.rejectResponse = undefined;
    reject?.(error);
  }

  private handleFrame(frame: DecodedFrame): void {
    const message = decodeMessage(frame.header.type, frame.payload);
    switch (message.type) {
      case MessageType.RESPONSE_HEAD:
        this.head = { status: message.status, headers: message.headers };
        break;
      case MessageType.RESPONSE_DATA:
        this.chunks.push(message.data);
        break;
      case MessageType.RESPONSE_END: {
        const head = this.head;
        if (head === undefined) {
          this.fail(new Error('RESPONSE_END before RESPONSE_HEAD'));
          break;
        }
        const resolve = this.resolveResponse;
        this.resolveResponse = undefined;
        this.rejectResponse = undefined;
        resolve?.({
          status: head.status,
          headers: head.headers,
          body: Buffer.concat(this.chunks).toString('utf8'),
        });
        break;
      }
      default:
        break;
    }
  }
}

interface Harness {
  peer: TunnelPeer;
  close: () => Promise<void>;
}

async function startHarness(
  deps: McpAuthorizationRouteDependencies,
): Promise<Harness> {
  // The list route only reads `mcp`; `config` exists to satisfy its dependency
  // contract.
  const mcpDeps: McpRouteDependencies = {
    ...deps,
    config: {} as Config,
  };
  const routes = setupTestApp((instance) => {
    instance
      .openapi(getMcpServersRoute, getMcpServers(mcpDeps))
      .openapi(completeAuthorizationRoute, completeAuthorization(deps));
  });
  // The tunnel dispatches into a plain Hono app, mirroring the admin server.
  const app = new Hono().route('/', routes);

  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (typeof address === 'string' || address === null) {
    throw new Error('WebSocketServer did not bind a port');
  }

  const serverSocket = new Promise<WebSocket>((resolve) =>
    server.once('connection', resolve),
  );
  const clientWs = new WebSocket(`ws://127.0.0.1:${address.port}`);
  await new Promise<void>((resolve, reject) => {
    clientWs.once('open', () => resolve());
    clientWs.once('error', reject);
  });

  const connection = new AgentTunnelConnection(clientWs, { app });
  connection.start();

  const peer = new TunnelPeer(await serverSocket);
  peer.welcome();

  return {
    peer,
    close: async () => {
      connection.close('test over');
      clientWs.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe('admin MCP authorization routes over a tunnel connection', () => {
  it('serves the server listing with its embedded authorization', async () => {
    const harness = await startHarness({
      mcp: {
        getServerStatuses: vi.fn(() => [authorizingServer]),
      } as unknown as Mcp,
      logger,
    });

    try {
      const response = await harness.peer.request(
        1,
        HttpMethod.GET,
        '/v1/mcp-servers',
      );

      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toEqual({
        servers: [authorizingServer],
      });
    } finally {
      await harness.close();
    }
  });

  it('delivers a callback body to the handler intact', async () => {
    const complete = vi.fn(
      (_state: string, _params: URLSearchParams) => 'accepted' as const,
    );
    const harness = await startHarness({
      mcp: { completeAuthorization: complete } as unknown as Mcp,
      logger,
    });

    try {
      const response = await harness.peer.request(
        1,
        HttpMethod.POST,
        '/v1/mcp-oauth/callback',
        JSON.stringify({ state: 'secret-state', code: 'auth-code' }),
      );

      expect(response.status).toBe(202);
      expect(JSON.parse(response.body)).toEqual({ accepted: true });
      const call = complete.mock.calls[0];
      expect(call?.[0]).toBe('secret-state');
      expect(call?.[1].get('code')).toBe('auth-code');
    } finally {
      await harness.close();
    }
  });
});
