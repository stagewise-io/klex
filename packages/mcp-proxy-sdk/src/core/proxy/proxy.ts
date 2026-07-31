import type {
  EnvironmentConnection,
  Unsubscribe,
} from '../connection/index.js';
import type { EnvironmentId } from '../identity/index.js';
import {
  createProxyExchangeId,
  type ExchangeOpenFrame,
  PROXY_PROTOCOL_VERSION,
  type ProxyExchangeId,
  type ProxyHeaders,
} from '../protocol/index.js';

export interface ProxyRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: ProxyHeaders;
  readonly body?: string;
}

export interface ProxyResponseHead {
  readonly status: number;
  readonly statusText: string;
  readonly headers: ProxyHeaders;
}

export interface ProxyExchange {
  readonly id: ProxyExchangeId;
  readonly response: Promise<ProxyResponseHead>;
  onChunk(handler: (data: string) => void): Unsubscribe;
  onClose(handler: (cause?: Error) => void): Unsubscribe;
  close(): Promise<void>;
}

export interface EnvironmentRegistration {
  close(): Promise<void>;
}

export interface McpProxy {
  registerEnvironment(
    environmentId: EnvironmentId,
    connection: EnvironmentConnection,
  ): EnvironmentRegistration;
  openExchange(
    environmentId: EnvironmentId,
    request: ProxyRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ProxyExchange>;
  close(): Promise<void>;
}

export interface ProxyDependencies {
  readonly createExchangeId?: () => ProxyExchangeId;
  readonly exchangeOpenTimeoutMs?: number;
}

interface Registration {
  readonly environmentId: EnvironmentId;
  readonly connection: EnvironmentConnection;
  readonly exchanges: Set<ExchangeModule>;
  readonly unsubscribe: Unsubscribe[];
  active: boolean;
}

class ExchangeModule implements ProxyExchange {
  readonly id: ProxyExchangeId;
  readonly response: Promise<ProxyResponseHead>;
  readonly #response = Promise.withResolvers<ProxyResponseHead>();
  readonly #registration: Registration;
  readonly #onEnded: () => void;
  readonly #chunkHandlers = new Set<(data: string) => void>();
  readonly #closeHandlers = new Set<(cause?: Error) => void>();
  readonly #pendingChunks: string[] = [];
  #opened = false;
  #closed = false;
  #closeCause: Error | undefined;

  constructor(
    id: ProxyExchangeId,
    registration: Registration,
    onEnded: () => void,
  ) {
    this.id = id;
    this.#registration = registration;
    this.#onEnded = onEnded;
    this.response = this.#response.promise;
    void this.response.catch(() => undefined);
  }

  onChunk(handler: (data: string) => void): Unsubscribe {
    this.#chunkHandlers.add(handler);
    for (const data of this.#pendingChunks.splice(0)) handler(data);
    return () => this.#chunkHandlers.delete(handler);
  }

  onClose(handler: (cause?: Error) => void): Unsubscribe {
    if (this.#closed) {
      handler(this.#closeCause);
      return () => undefined;
    }
    this.#closeHandlers.add(handler);
    return () => this.#closeHandlers.delete(handler);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.end();
    await this.#registration.connection.send({
      version: PROXY_PROTOCOL_VERSION,
      type: 'exchange.close',
      exchangeId: this.id,
    });
  }

  open(head: ProxyResponseHead): void {
    if (this.#closed || this.#opened) return;
    this.#opened = true;
    this.#response.resolve(head);
  }

  chunk(data: string): void {
    if (this.#closed || !this.#opened) return;
    if (this.#chunkHandlers.size === 0) {
      this.#pendingChunks.push(data);
      return;
    }
    for (const handler of this.#chunkHandlers) handler(data);
  }

  end(cause?: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeCause = cause;
    this.#onEnded();
    if (!this.#opened)
      this.#response.reject(
        cause ?? new Error('Exchange closed before response'),
      );
    for (const handler of this.#closeHandlers) handler(cause);
    this.#chunkHandlers.clear();
    this.#closeHandlers.clear();
  }
}

class ProxyModule implements McpProxy {
  readonly #createExchangeId: () => ProxyExchangeId;
  readonly #exchangeOpenTimeoutMs: number;
  readonly #registrations = new Map<string, Registration>();
  readonly #exchanges = new Map<ProxyExchangeId, ExchangeModule>();
  #closed = false;

  constructor(dependencies: ProxyDependencies = {}) {
    this.#createExchangeId =
      dependencies.createExchangeId ??
      (() => createProxyExchangeId(globalThis.crypto.randomUUID()));
    this.#exchangeOpenTimeoutMs = dependencies.exchangeOpenTimeoutMs ?? 30_000;
    if (
      !Number.isFinite(this.#exchangeOpenTimeoutMs) ||
      this.#exchangeOpenTimeoutMs <= 0
    ) {
      throw new RangeError('Exchange open timeout must be a positive number');
    }
  }

  registerEnvironment(
    environmentId: EnvironmentId,
    connection: EnvironmentConnection,
  ): EnvironmentRegistration {
    if (this.#closed) throw new Error('Proxy is closed');
    const registration: Registration = {
      environmentId,
      connection,
      exchanges: new Set(),
      unsubscribe: [],
      active: true,
    };
    registration.unsubscribe.push(
      connection.onFrame((frame) => {
        if (!registration.active) return;
        const exchange = this.#exchanges.get(frame.exchangeId);
        if (!exchange || !registration.exchanges.has(exchange)) return;
        if (frame.type === 'exchange.opened') {
          exchange.open({
            status: frame.status,
            statusText: frame.statusText,
            headers: frame.headers,
          });
        } else if (frame.type === 'exchange.chunk') exchange.chunk(frame.data);
        else exchange.end(frame.reason ? new Error(frame.reason) : undefined);
      }),
      connection.onClose((cause) => {
        void this.#stopRegistration(
          registration,
          cause ?? new Error('Environment disconnected'),
          false,
        );
      }),
    );
    const previous = this.#registrations.get(environmentId);
    this.#registrations.set(environmentId, registration);
    if (previous) {
      void this.#stopRegistration(
        previous,
        new Error('Environment connection replaced'),
        true,
      ).catch(() => undefined);
    }
    return {
      close: () =>
        this.#stopRegistration(
          registration,
          new Error('Environment unregistered'),
          true,
        ),
    };
  }

  async openExchange(
    environmentId: EnvironmentId,
    request: ProxyRequest,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<ProxyExchange> {
    if (this.#closed) throw new Error('Proxy is closed');
    if (options.signal?.aborted) throw abortError();
    const registration = this.#registrations.get(environmentId);
    if (!registration?.active) throw new Error('Environment is unavailable');
    const id = this.#createExchangeId();
    if (this.#exchanges.has(id)) throw new Error('Duplicate proxy exchange ID');
    const exchange = new ExchangeModule(id, registration, () => {
      registration.exchanges.delete(exchange);
      this.#exchanges.delete(id);
    });
    registration.exchanges.add(exchange);
    this.#exchanges.set(id, exchange);
    const onAbort = () => void exchange.close().catch(() => undefined);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(
      () => void exchange.close().catch(() => undefined),
      this.#exchangeOpenTimeoutMs,
    );
    const unsubscribe = exchange.onClose(() => {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
    });
    try {
      const frame: ExchangeOpenFrame = {
        version: PROXY_PROTOCOL_VERSION,
        type: 'exchange.open',
        exchangeId: id,
        ...request,
      };
      await registration.connection.send(frame);
      await exchange.response;
      if (options.signal?.aborted) throw abortError();
      return exchange;
    } catch (cause) {
      exchange.end(cause instanceof Error ? cause : new Error(String(cause)));
      throw cause;
    } finally {
      unsubscribe();
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.allSettled(
      [...this.#registrations.values()].map((registration) =>
        this.#stopRegistration(registration, new Error('Proxy closed'), true),
      ),
    );
  }

  #stopRegistration(
    registration: Registration,
    cause: Error,
    closeConnection: boolean,
  ): Promise<void> {
    if (!registration.active) return Promise.resolve();
    registration.active = false;
    for (const unsubscribe of registration.unsubscribe) unsubscribe();
    registration.unsubscribe.length = 0;
    if (this.#registrations.get(registration.environmentId) === registration)
      this.#registrations.delete(registration.environmentId);
    for (const exchange of [...registration.exchanges]) exchange.end(cause);
    return closeConnection
      ? registration.connection.close()
      : Promise.resolve();
  }
}

export function createProxy(dependencies: ProxyDependencies = {}): McpProxy {
  return new ProxyModule(dependencies);
}

function abortError(): Error {
  const error = new Error('Exchange opening aborted');
  error.name = 'AbortError';
  return error;
}
