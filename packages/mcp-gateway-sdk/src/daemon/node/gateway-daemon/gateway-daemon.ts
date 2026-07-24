import WebSocket, { type RawData } from 'ws';

import {
  decodeGatewayToEnvironmentFrame,
  type EnvironmentToGatewayFrame,
  encodeGatewayFrame,
  GATEWAY_PROTOCOL_VERSION,
  type GatewayExchangeId,
  MAX_GATEWAY_CHUNK_BYTES,
} from '../../../core/index.js';

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
export interface GatewayEnvironmentHandler {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
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
  readonly handler: GatewayEnvironmentHandler;
  readonly reconnect?: false | GatewayDaemonReconnectOptions;
}
export interface GatewayDaemon {
  start(): Promise<void>;
  close(): Promise<void>;
  readonly state: GatewayDaemonState;
  readonly activeExchangeCount: number;
}
interface VirtualExchange {
  readonly controller: AbortController;
  reader?: ReadableStreamDefaultReader<Uint8Array>;
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
  readonly #handler: GatewayEnvironmentHandler;
  readonly #reconnect: ReconnectPolicy | false;
  readonly #exchanges = new Map<GatewayExchangeId, VirtualExchange>();
  #socket?: WebSocket;
  #sendChain = Promise.resolve();
  #dispatchChain = Promise.resolve();
  #state: GatewayDaemonState = 'idle';
  #started = false;
  #closed = false;
  #handlerClosed = false;
  #reconnectTask?: Promise<void>;
  #retryTimer?: ReturnType<typeof setTimeout>;
  #resolveRetry?: () => void;

  constructor(options: GatewayDaemonOptions) {
    this.#url = new URL(options.gatewayUrl);
    if (this.#url.protocol !== 'ws:' && this.#url.protocol !== 'wss:') {
      throw new TypeError('Gateway URL must use ws: or wss:');
    }
    this.#authorization = normalizeCredential(options.credential);
    this.#handler = options.handler;
    this.#reconnect = normalizeReconnect(options.reconnect);
  }

  get state(): GatewayDaemonState {
    return this.#state;
  }
  get activeExchangeCount(): number {
    return this.#exchanges.size;
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
      await this.#closeExchanges();
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
    await this.#closeExchanges();
    await this.#reconnectTask?.catch(() => undefined);
    if (!this.#handlerClosed) {
      this.#handlerClosed = true;
      await this.#handler.close();
    }
  }

  async #connect(): Promise<void> {
    const authorization = validateAuthorization(await this.#authorization());
    if (this.#closed) throw new Error('Daemon is closed');
    const socket = new WebSocket(this.#url, { headers: { authorization } });
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
    if (frame.type === 'exchange.open') {
      if (this.#exchanges.has(frame.exchangeId))
        throw new Error('Duplicate exchange');
      const exchange: VirtualExchange = { controller: new AbortController() };
      this.#exchanges.set(frame.exchangeId, exchange);
      void this.#serve(frame, exchange);
      return;
    }
    const exchange = this.#exchanges.get(frame.exchangeId);
    if (!exchange) return;
    await this.#removeExchange(frame.exchangeId, exchange);
  }

  async #serve(
    frame: Extract<
      ReturnType<typeof decodeGatewayToEnvironmentFrame>,
      { type: 'exchange.open' }
    >,
    exchange: VirtualExchange,
  ): Promise<void> {
    try {
      const body = frame.body ? base64ToBytes(frame.body) : undefined;
      const response = await this.#handler.fetch(
        new Request(frame.url, {
          method: frame.method,
          headers: frame.headers,
          ...(body ? { body } : {}),
          signal: exchange.controller.signal,
        }),
      );
      if (!this.#exchanges.has(frame.exchangeId)) return;
      await this.#send({
        version: GATEWAY_PROTOCOL_VERSION,
        type: 'exchange.opened',
        exchangeId: frame.exchangeId,
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers),
      });
      if (response.body) {
        const reader = response.body.getReader();
        exchange.reader = reader;
        while (this.#exchanges.has(frame.exchangeId)) {
          const result = await reader.read();
          if (result.done) break;
          for (
            let offset = 0;
            offset < result.value.length;
            offset += MAX_GATEWAY_CHUNK_BYTES
          ) {
            await this.#send({
              version: GATEWAY_PROTOCOL_VERSION,
              type: 'exchange.chunk',
              exchangeId: frame.exchangeId,
              data: bytesToBase64(
                result.value.subarray(offset, offset + MAX_GATEWAY_CHUNK_BYTES),
              ),
            });
          }
        }
      }
      if (this.#exchanges.delete(frame.exchangeId)) {
        await this.#send({
          version: GATEWAY_PROTOCOL_VERSION,
          type: 'exchange.close',
          exchangeId: frame.exchangeId,
        });
      }
    } catch (cause) {
      if (this.#exchanges.delete(frame.exchangeId)) {
        await this.#send({
          version: GATEWAY_PROTOCOL_VERSION,
          type: 'exchange.close',
          exchangeId: frame.exchangeId,
          reason: errorMessage(cause),
        }).catch(() => undefined);
      }
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
    await this.#closeExchanges();
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
  async #removeExchange(
    id: GatewayExchangeId,
    exchange: VirtualExchange,
  ): Promise<void> {
    this.#exchanges.delete(id);
    exchange.controller.abort();
    await exchange.reader?.cancel().catch(() => undefined);
  }
  async #closeExchanges(): Promise<void> {
    const exchanges = [...this.#exchanges.values()];
    this.#exchanges.clear();
    await Promise.allSettled(
      exchanges.map(async (exchange) => {
        exchange.controller.abort();
        await exchange.reader?.cancel().catch(() => undefined);
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
  )
    throw new TypeError('Invalid reconnect policy');
  return policy;
}
function reconnectDelay(policy: ReconnectPolicy, attempt: number): number {
  const base = Math.min(
    policy.maximumDelayMs,
    policy.initialDelayMs * policy.factor ** attempt,
  );
  return Math.max(
    0,
    Math.round(base + base * policy.jitter * (Math.random() * 2 - 1)),
  );
}
function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}
function base64ToBytes(value: string): Uint8Array {
  return Buffer.from(value, 'base64');
}
function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
