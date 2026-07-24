import { createServer, type Server } from 'node:http';

import {
  createGateway,
  type Gateway,
  type GatewayAuthorization,
} from '@stagewise/mcp-gateway-core';

import {
  createGatewayNodeHandlers,
  type GatewayNodeHandlersOptions,
} from '../gateway-node-handlers/index.js';

export interface GatewayServerOptions
  extends Omit<GatewayNodeHandlersOptions, 'gateway'> {
  readonly authorization: GatewayAuthorization;
  readonly sessionOpenTimeoutMs?: number;
  readonly host?: string;
  readonly port?: number;
}

export interface GatewayServerAddress {
  readonly host: string;
  readonly port: number;
  readonly origin: string;
  readonly mcpUrl: (environmentId: string) => URL;
  readonly environmentUrl: URL;
}

export interface GatewayServer {
  start(): Promise<GatewayServerAddress>;
  close(): Promise<void>;
  readonly httpServer: Server;
  readonly gateway: Gateway;
  readonly sessionCount: number;
}

class GatewayServerModule implements GatewayServer {
  readonly gateway: Gateway;
  readonly httpServer: Server;
  readonly #handlers: ReturnType<typeof createGatewayNodeHandlers>;
  readonly #host: string;
  readonly #port: number;
  readonly #environmentPath: string;
  #address?: GatewayServerAddress;
  #closed = false;

  constructor(options: GatewayServerOptions) {
    this.#host = options.host ?? '127.0.0.1';
    this.#port = options.port ?? 0;
    this.#environmentPath = options.environmentWebSocketPath ?? '/environment';
    this.gateway = createGateway({
      authorization: options.authorization,
      sessionOpenTimeoutMs: options.sessionOpenTimeoutMs,
    });
    this.#handlers = createGatewayNodeHandlers({
      ...options,
      gateway: this.gateway,
    });
    this.httpServer = createServer((request, response) => {
      void this.#handlers.handleHttp(request, response);
    });
    this.httpServer.on('upgrade', (request, socket, head) => {
      void this.#handlers.handleEnvironmentUpgrade(request, socket, head);
    });
  }

  get sessionCount(): number {
    return this.#handlers.sessionCount;
  }

  async start(): Promise<GatewayServerAddress> {
    if (this.#closed) throw new Error('Gateway server is closed');
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
        throw new Error('Gateway server has no TCP address');
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
    await this.gateway.close();
  }
}

export function createGatewayServer(
  options: GatewayServerOptions,
): GatewayServer {
  return new GatewayServerModule(options);
}
