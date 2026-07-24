import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

import { toNodeHandler } from '@modelcontextprotocol/node';

import {
  createGatewayHttp,
  type GatewayHttpOptions,
} from '../../http/index.js';
import {
  createEnvironmentUpgradeHandler,
  type EnvironmentUpgradeOptions,
} from '../environment-upgrade/index.js';

export interface GatewayNodeHandlersOptions
  extends GatewayHttpOptions,
    Omit<EnvironmentUpgradeOptions, 'gateway' | 'onError'> {
  readonly environmentWebSocketPath?: string;
}

export interface GatewayNodeHandlers {
  readonly handleHttp: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => Promise<void>;
  readonly handleEnvironmentUpgrade: (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => Promise<boolean>;
  close(): Promise<void>;
  readonly exchangeCount: number;
}

class GatewayNodeHandlersModule implements GatewayNodeHandlers {
  readonly #http: ReturnType<typeof createGatewayHttp>;
  readonly #upgrade: ReturnType<typeof createEnvironmentUpgradeHandler>;
  readonly #nodeHandler: ReturnType<typeof toNodeHandler>;
  #closed = false;

  constructor(options: GatewayNodeHandlersOptions) {
    this.#http = createGatewayHttp(options);
    this.#upgrade = createEnvironmentUpgradeHandler({
      gateway: options.gateway,
      authenticateEnvironment: options.authenticateEnvironment,
      route: options.environmentWebSocketPath,
      onConnected: options.onConnected,
      onError: options.hooks?.onError,
    });
    this.#nodeHandler = toNodeHandler(this.#http, {
      onerror: (error) => options.hooks?.onError?.({ error }),
    });
  }

  get exchangeCount(): number {
    return this.#http.exchangeCount;
  }

  readonly handleHttp = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    await this.#nodeHandler(request, response);
  };

  readonly handleEnvironmentUpgrade = async (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<boolean> => this.#upgrade.handle(request, socket, head);

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.allSettled([this.#http.close(), this.#upgrade.close()]);
  }
}

export function createGatewayNodeHandlers(
  options: GatewayNodeHandlersOptions,
): GatewayNodeHandlers {
  return new GatewayNodeHandlersModule(options);
}
