import { createServer, type Server } from 'node:http';

import { createProxy, type McpProxy } from '../../core/index.js';
import {
  createProxyNodeHandlers,
  type ProxyNodeHandlersOptions,
} from '../proxy-node-handlers/index.js';

export interface ProxyServerOptions
  extends Omit<ProxyNodeHandlersOptions, 'proxy'> {
  readonly exchangeOpenTimeoutMs?: number;
  readonly host?: string;
  readonly port?: number;
}

export interface ProxyServerAddress {
  readonly host: string;
  readonly port: number;
  readonly origin: string;
  readonly mcpUrl: (environmentId: string) => URL;
  readonly environmentUrl: URL;
}

export interface ProxyServer {
  start(): Promise<ProxyServerAddress>;
  close(): Promise<void>;
  readonly httpServer: Server;
  readonly proxy: McpProxy;
  readonly exchangeCount: number;
}

class ProxyServerModule implements ProxyServer {
  readonly proxy: McpProxy;
  readonly httpServer: Server;
  readonly #handlers: ReturnType<typeof createProxyNodeHandlers>;
  readonly #host: string;
  readonly #port: number;
  readonly #environmentPath: string;
  #address?: ProxyServerAddress;
  #closed = false;

  constructor(options: ProxyServerOptions) {
    this.#host = options.host ?? '127.0.0.1';
    this.#port = options.port ?? 0;
    this.#environmentPath = options.environmentWebSocketPath ?? '/environment';
    this.proxy = createProxy({
      exchangeOpenTimeoutMs: options.exchangeOpenTimeoutMs,
    });
    this.#handlers = createProxyNodeHandlers({
      ...options,
      proxy: this.proxy,
    });
    this.httpServer = createServer((request, response) => {
      void this.#handlers.handleHttp(request, response);
    });
    this.httpServer.on('upgrade', (request, socket, head) => {
      void this.#handlers.handleEnvironmentUpgrade(request, socket, head);
    });
  }

  get exchangeCount(): number {
    return this.#handlers.exchangeCount;
  }

  async start(): Promise<ProxyServerAddress> {
    if (this.#closed) throw new Error('Proxy server is closed');
    if (this.#address) return this.#address;
    try {
      await new Promise<void>((resolve, reject) => {
        this.httpServer.once('error', reject);
        this.httpServer.listen(this.#port, this.#host, () => {
          this.httpServer.off('error', reject);
          resolve();
        });
      });
      const address = this.httpServer.address();
      if (typeof address === 'string' || address === null) {
        throw new Error('Proxy server has no TCP address');
      }
      const origin = `http://${address.address}:${address.port}`;
      this.#address = {
        host: address.address,
        port: address.port,
        origin,
        mcpUrl: (environmentId) =>
          new URL(
            `/environments/${encodeURIComponent(environmentId)}/mcp`,
            origin,
          ),
        environmentUrl: new URL(
          this.#environmentPath,
          origin.replace(/^http/, 'ws'),
        ),
      };
      return this.#address;
    } catch (cause) {
      await this.close();
      throw cause;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.httpServer.listening) {
      await new Promise<void>((resolve) =>
        this.httpServer.close(() => resolve()),
      );
    }
    await this.#handlers.close();
    await this.proxy.close();
  }
}

export function createProxyServer(options: ProxyServerOptions): ProxyServer {
  return new ProxyServerModule(options);
}
