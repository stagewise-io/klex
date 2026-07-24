import type { McpServer } from '@modelcontextprotocol/server';
import WebSocket, { type RawData } from 'ws';

import {
  decodeGatewayToEnvironmentFrame,
  type EnvironmentToGatewayFrame,
  encodeGatewayFrame,
  GATEWAY_PROTOCOL_VERSION,
  type GatewaySessionId,
} from '@stagewise/mcp-gateway-core';

import {
  createEnvironmentTransport,
  type EnvironmentTransport,
} from '../environment-transport/index.js';

export interface BearerCredential {
  readonly type: 'bearer';
  readonly token: string;
}

export type AuthorizationProvider = () => string | Promise<string>;

export interface GatewayDaemonReconnectOptions {
  readonly initialDelayMs?: number;
  readonly maximumDelayMs?: number;
  readonly factor?: number;
  readonly jitter?: number;
}

export interface GatewayDaemonSessionContext {
  readonly sessionId: GatewaySessionId;
  readonly signal: AbortSignal;
}

export type GatewayDaemonState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'closed';

export interface GatewayDaemonOptions {
  readonly gatewayUrl: URL | string;
  readonly credential: BearerCredential | AuthorizationProvider;
  readonly createServer: (
    context: GatewayDaemonSessionContext,
  ) => McpServer | Promise<McpServer>;
  readonly reconnect?: false | GatewayDaemonReconnectOptions;
}

export interface GatewayDaemon {
  start(): Promise<void>;
  close(): Promise<void>;
  readonly state: GatewayDaemonState;
  readonly activeSessionCount: number;
}

interface VirtualSession {
  readonly controller: AbortController;
  readonly server: McpServer;
  readonly transport: EnvironmentTransport;
}

interface ReconnectPolicy {
  readonly initialDelayMs: number;
  readonly maximumDelayMs: number;
  readonly factor: number;
  readonly jitter: number;
}

const DEFAULT_RECONNECT: ReconnectPolicy = {
  initialDelayMs: 250,
  maximumDelayMs: 30_000,
  factor: 2,
  jitter: 0.2,
};

class GatewayDaemonModule implements GatewayDaemon {
  readonly #url: URL;
  readonly #authorization: AuthorizationProvider;
  readonly #createServer: GatewayDaemonOptions['createServer'];
  readonly #reconnect: ReconnectPolicy | false;
  readonly #sessions = new Map<GatewaySessionId, VirtualSession>();
  #socket?: WebSocket;
  #sendChain = Promise.resolve();
  #dispatchChain = Promise.resolve();
  #state: GatewayDaemonState = 'idle';
  #started = false;
  #closed = false;
  #reconnectTask?: Promise<void>;
  #retryTimer?: ReturnType<typeof setTimeout>;
  #resolveRetry?: () => void;

  constructor(options: GatewayDaemonOptions) {
    this.#url = new URL(options.gatewayUrl);
    if (this.#url.protocol !== 'ws:' && this.#url.protocol !== 'wss:') {
      throw new TypeError('Gateway URL must use ws: or wss:');
    }
    this.#authorization = normalizeCredential(options.credential);
    this.#createServer = options.createServer;
    this.#reconnect = normalizeReconnect(options.reconnect);
  }

  get state(): GatewayDaemonState {
    return this.#state;
  }

  get activeSessionCount(): number {
    return this.#sessions.size;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    if (this.#closed) throw new Error('Daemon is closed');
    this.#state = 'connecting';
    try {
      await this.#connect();
      this.#started = true;
      this.#state = 'connected';
    } catch (cause) {
      await this.#closeSocket();
      await this.#closeSessions();
      this.#state = 'idle';
      throw cause;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#state = 'closed';
    this.#cancelRetry();
    await this.#closeSocket();
    await this.#closeSessions();
    await this.#reconnectTask?.catch(() => undefined);
  }

  async #connect(): Promise<void> {
    const authorization = validateAuthorization(await this.#authorization());
    if (this.#closed) throw new Error('Daemon is closed');

    const socket = new WebSocket(this.#url, {
      headers: { authorization },
    });
    this.#socket = socket;
    socket.on('message', (data, isBinary) =>
      this.#queueDispatch(socket, data, isBinary),
    );
    socket.on('error', () => socket.terminate());
    socket.once('close', () => void this.#handleSocketClose(socket));

    await new Promise<void>((resolve, reject) => {
      const opened = () => {
        cleanup();
        resolve();
      };
      const failed = () => {
        cleanup();
        reject(new Error('Gateway connection failed'));
      };
      const cleanup = () => {
        socket.off('open', opened);
        socket.off('close', failed);
        socket.off('error', failed);
      };
      socket.once('open', opened);
      socket.once('close', failed);
      socket.once('error', failed);
    });
  }

  #queueDispatch(socket: WebSocket, data: RawData, isBinary: boolean): void {
    const operation = this.#dispatchChain.then(async () => {
      if (socket !== this.#socket) return;
      await this.#dispatch(data, isBinary);
    });
    this.#dispatchChain = operation.catch(() => {
      if (socket === this.#socket) socket.close(1002, 'Protocol error');
    });
  }

  async #dispatch(data: RawData, isBinary: boolean): Promise<void> {
    if (isBinary) throw new Error('Binary frames are unsupported');
    const frame = decodeGatewayToEnvironmentFrame(data.toString('utf8'));
    if (frame.type === 'session.open') {
      await this.#openSession(frame.sessionId);
      return;
    }

    const session = this.#sessions.get(frame.sessionId);
    if (!session) throw new Error('Unknown daemon session');
    if (frame.type === 'session.message') {
      session.transport.receive(frame.message, frame.options);
      return;
    }

    await this.#removeSession(frame.sessionId, session);
    await this.#send({
      version: GATEWAY_PROTOCOL_VERSION,
      type: 'session.close',
      sessionId: frame.sessionId,
    });
  }

  async #openSession(sessionId: GatewaySessionId): Promise<void> {
    if (this.#sessions.has(sessionId))
      throw new Error('Duplicate daemon session');
    const controller = new AbortController();
    const transport = createEnvironmentTransport(sessionId, (frame) =>
      this.#send(frame),
    );
    let server: McpServer | undefined;
    try {
      server = await this.#createServer({
        sessionId,
        signal: controller.signal,
      });
      const session = { controller, server, transport };
      this.#sessions.set(sessionId, session);
      await server.connect(transport);
      await this.#send({
        version: GATEWAY_PROTOCOL_VERSION,
        type: 'session.opened',
        sessionId,
      });
    } catch {
      this.#sessions.delete(sessionId);
      controller.abort();
      await Promise.allSettled([
        transport.close(),
        ...(server ? [server.close()] : []),
      ]);
      await this.#send({
        version: GATEWAY_PROTOCOL_VERSION,
        type: 'session.close',
        sessionId,
        reason: 'Failed to create MCP session',
      });
    }
  }

  #send(frame: EnvironmentToGatewayFrame): Promise<void> {
    const operation = this.#sendChain.then(
      () =>
        new Promise<void>((resolve, reject) => {
          const socket = this.#socket;
          if (!socket || socket.readyState !== WebSocket.OPEN) {
            reject(new Error('Gateway connection is closed'));
            return;
          }
          socket.send(encodeGatewayFrame(frame), (error) =>
            error ? reject(error) : resolve(),
          );
        }),
    );
    this.#sendChain = operation.catch(() => undefined);
    return operation;
  }

  async #handleSocketClose(socket: WebSocket): Promise<void> {
    if (socket !== this.#socket) return;
    this.#socket = undefined;
    await this.#closeSessions();
    if (this.#closed) return;
    if (!this.#started || this.#reconnect === false) {
      this.#state = 'idle';
      return;
    }
    this.#state = 'reconnecting';
    this.#reconnectTask ??= this.#reconnectLoop().finally(() => {
      this.#reconnectTask = undefined;
    });
  }

  async #reconnectLoop(): Promise<void> {
    if (this.#reconnect === false) return;
    let attempt = 0;
    while (!this.#closed && !this.#socket) {
      await this.#waitForRetry(reconnectDelay(this.#reconnect, attempt++));
      if (this.#closed) return;
      try {
        await this.#connect();
        this.#state = 'connected';
        return;
      } catch {
        await this.#closeSocket();
      }
    }
  }

  #waitForRetry(delayMs: number): Promise<void> {
    return new Promise((resolve) => {
      this.#resolveRetry = resolve;
      this.#retryTimer = setTimeout(() => {
        this.#retryTimer = undefined;
        this.#resolveRetry = undefined;
        resolve();
      }, delayMs);
    });
  }

  #cancelRetry(): void {
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    this.#resolveRetry?.();
    this.#resolveRetry = undefined;
  }

  async #closeSocket(): Promise<void> {
    const socket = this.#socket;
    if (!socket) return;
    this.#socket = undefined;
    if (socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      socket.once('close', () => resolve());
      if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
      else socket.close();
    });
  }

  async #removeSession(
    sessionId: GatewaySessionId,
    session: VirtualSession,
  ): Promise<void> {
    this.#sessions.delete(sessionId);
    session.controller.abort();
    await Promise.allSettled([
      session.server.close(),
      session.transport.close(),
    ]);
  }

  async #closeSessions(): Promise<void> {
    const sessions = [...this.#sessions.entries()];
    this.#sessions.clear();
    await Promise.allSettled(
      sessions.map(async ([, session]) => {
        session.controller.abort();
        await Promise.allSettled([
          session.server.close(),
          session.transport.close(),
        ]);
      }),
    );
  }
}

export function createGatewayDaemon(
  options: GatewayDaemonOptions,
): GatewayDaemon {
  return new GatewayDaemonModule(options);
}

function normalizeCredential(
  credential: BearerCredential | AuthorizationProvider,
): AuthorizationProvider {
  if (typeof credential === 'function') return credential;
  return () => `Bearer ${credential.token}`;
}

function validateAuthorization(value: string): string {
  if (!/^Bearer [^\s]+$/.test(value)) {
    throw new TypeError('Authorization must be a non-empty Bearer credential');
  }
  return value;
}

function normalizeReconnect(
  reconnect: GatewayDaemonOptions['reconnect'],
): ReconnectPolicy | false {
  if (reconnect === false) return false;
  const policy = { ...DEFAULT_RECONNECT, ...reconnect };
  if (
    policy.initialDelayMs < 0 ||
    policy.maximumDelayMs < policy.initialDelayMs ||
    policy.factor < 1 ||
    policy.jitter < 0 ||
    policy.jitter > 1
  ) {
    throw new TypeError('Invalid reconnect policy');
  }
  return policy;
}

function reconnectDelay(policy: ReconnectPolicy, attempt: number): number {
  const base = Math.min(
    policy.maximumDelayMs,
    policy.initialDelayMs * policy.factor ** attempt,
  );
  const variation = base * policy.jitter * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(base + variation));
}
