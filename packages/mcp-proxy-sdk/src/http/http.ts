import type {
  EnvironmentId,
  McpProxy,
  ProxyExchange,
  ProxyHeaders,
} from '../core/index.js';

export interface ProxyHttpHooks {
  readonly onExchangeOpened?: (details: {
    readonly proxyExchangeId: string;
    readonly environmentId: EnvironmentId;
  }) => void;
  readonly onExchangeClosed?: (details: {
    readonly proxyExchangeId: string;
    readonly cause?: Error;
  }) => void;
  readonly onError?: (details: { readonly error: Error }) => void;
}

export interface ProxyHttpOptions {
  readonly proxy: McpProxy;
  readonly parseEnvironmentId: (value: string) => EnvironmentId;
  readonly routePrefix?: string;
  readonly hooks?: ProxyHttpHooks;
}

export interface ProxyHttp {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
  readonly exchangeCount: number;
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

class ProxyHttpModule implements ProxyHttp {
  readonly #options: ProxyHttpOptions;
  readonly #routePrefix: string;
  readonly #exchanges = new Set<ProxyExchange>();
  #closed = false;

  constructor(options: ProxyHttpOptions) {
    this.#options = options;
    this.#routePrefix = options.routePrefix ?? '/environments/';
  }

  get exchangeCount(): number {
    return this.#exchanges.size;
  }

  async fetch(request: Request): Promise<Response> {
    if (this.#closed)
      return new Response('Proxy HTTP handler is closed', { status: 503 });
    const environmentId = this.#environmentId(request);
    if (!environmentId) return new Response(null, { status: 404 });
    let body: string | undefined;
    try {
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.length > 0) body = bytesToBase64(bytes);
    } catch (cause) {
      this.#report(cause);
      return new Response('Invalid request body', { status: 400 });
    }
    let exchange: ProxyExchange;
    try {
      exchange = await this.#options.proxy.openExchange(
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
      proxyExchangeId: exchange.id,
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
        proxyExchangeId: exchange.id,
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

export function createProxyHttp(options: ProxyHttpOptions): ProxyHttp {
  return new ProxyHttpModule(options);
}

function sanitizeHeaders(headers: Headers): ProxyHeaders {
  const result: ProxyHeaders = {};
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
