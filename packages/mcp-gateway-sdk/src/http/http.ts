import type {
  AgentPrincipal,
  EnvironmentId,
  Gateway,
  GatewayExchange,
  GatewayHeaders,
} from '../core/index.js';

export interface GatewayHttpRequestContext {
  readonly request: Request;
}

export type AgentAuthenticator = (
  context: GatewayHttpRequestContext,
) => AgentPrincipal | undefined | Promise<AgentPrincipal | undefined>;

export interface GatewayHttpHooks {
  readonly onExchangeOpened?: (details: {
    readonly gatewayExchangeId: string;
    readonly environmentId: EnvironmentId;
  }) => void;
  readonly onExchangeClosed?: (details: {
    readonly gatewayExchangeId: string;
    readonly cause?: Error;
  }) => void;
  readonly onError?: (details: { readonly error: Error }) => void;
}

export interface GatewayHttpOptions {
  readonly gateway: Gateway;
  readonly authenticateAgent: AgentAuthenticator;
  readonly parseEnvironmentId: (value: string) => EnvironmentId;
  readonly routePrefix?: string;
  readonly hooks?: GatewayHttpHooks;
}

export interface GatewayHttp {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
  readonly exchangeCount: number;
}

const HOP_BY_HOP = new Set([
  'authorization',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

class GatewayHttpModule implements GatewayHttp {
  readonly #options: GatewayHttpOptions;
  readonly #routePrefix: string;
  readonly #exchanges = new Set<GatewayExchange>();
  #closed = false;

  constructor(options: GatewayHttpOptions) {
    this.#options = options;
    this.#routePrefix = options.routePrefix ?? '/environments/';
  }

  get exchangeCount(): number {
    return this.#exchanges.size;
  }

  async fetch(request: Request): Promise<Response> {
    if (this.#closed)
      return new Response('Gateway HTTP handler is closed', { status: 503 });
    const environmentId = this.#environmentId(request);
    if (!environmentId) return new Response(null, { status: 404 });
    let agent: AgentPrincipal | undefined;
    try {
      agent = await this.#options.authenticateAgent({ request });
    } catch (cause) {
      this.#report(cause);
      return new Response('Unauthorized', { status: 401 });
    }
    if (!agent) return new Response('Unauthorized', { status: 401 });
    let body: string | undefined;
    try {
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.length > 0) body = bytesToBase64(bytes);
    } catch (cause) {
      this.#report(cause);
      return new Response('Invalid request body', { status: 400 });
    }
    let exchange: GatewayExchange;
    try {
      exchange = await this.#options.gateway.openExchange(
        agent,
        environmentId,
        {
          method: request.method,
          url: request.url,
          headers: sanitizeHeaders(request.headers),
          ...(body ? { body } : {}),
        },
        { signal: request.signal },
      );
    } catch (cause) {
      this.#report(cause);
      return new Response(errorMessage(cause), { status: 503 });
    }
    this.#exchanges.add(exchange);
    this.#options.hooks?.onExchangeOpened?.({
      gatewayExchangeId: exchange.id,
      environmentId,
    });
    const head = await exchange.response;
    let ended = false;
    let removeChunk: () => void = () => undefined;
    let removeClose: () => void = () => undefined;
    const finish = async (cause?: unknown, closeRemote = false) => {
      if (ended) return;
      ended = true;
      removeChunk();
      removeClose();
      this.#exchanges.delete(exchange);
      if (closeRemote) await exchange.close().catch(() => undefined);
      this.#options.hooks?.onExchangeClosed?.({
        gatewayExchangeId: exchange.id,
        ...(cause !== undefined ? { cause: asError(cause) } : {}),
      });
    };
    const bodyStream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        removeChunk = exchange.onChunk((data) => {
          try {
            controller.enqueue(base64ToBytes(data));
          } catch (cause) {
            controller.error(cause);
            void finish(cause, true);
          }
        });
        removeClose = exchange.onClose((cause) => {
          if (cause) controller.error(cause);
          else controller.close();
          void finish(cause);
        });
      },
      cancel: (reason) => finish(reason, true),
    });
    return new Response(bodyStream, {
      status: head.status,
      statusText: head.statusText,
      headers: sanitizeHeaders(new Headers(head.headers)),
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const exchanges = [...this.#exchanges];
    this.#exchanges.clear();
    await Promise.allSettled(exchanges.map((exchange) => exchange.close()));
  }

  #environmentId(request: Request): EnvironmentId | undefined {
    const path = new URL(request.url).pathname;
    if (!path.startsWith(this.#routePrefix) || !path.endsWith('/mcp')) return;
    const value = path.slice(this.#routePrefix.length, -'/mcp'.length);
    if (!value || value.includes('/')) return;
    try {
      return this.#options.parseEnvironmentId(decodeURIComponent(value));
    } catch {
      return;
    }
  }

  #report(cause: unknown): void {
    this.#options.hooks?.onError?.({ error: asError(cause) });
  }
}

export function createGatewayHttp(options: GatewayHttpOptions): GatewayHttp {
  return new GatewayHttpModule(options);
}

function sanitizeHeaders(headers: Headers): GatewayHeaders {
  const result: GatewayHeaders = {};
  for (const [name, value] of headers) {
    if (!HOP_BY_HOP.has(name.toLowerCase())) result[name.toLowerCase()] = value;
  }
  return result;
}

function bytesToBase64(bytes: Uint8Array): string {
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function errorMessage(cause: unknown): string {
  return asError(cause).message;
}
