import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import { WebSocketServer } from 'ws';

import type {
  EnvironmentPrincipal,
  EnvironmentRegistration,
  Gateway,
} from '@stagewise/mcp-gateway-core';

import {
  createWebSocketEnvironmentConnection,
  type WebSocketEnvironmentConnection,
} from '../websocket-environment-connection/index.js';

export interface EnvironmentUpgradeContext {
  readonly request: IncomingMessage;
}

export type EnvironmentAuthenticator = (
  context: EnvironmentUpgradeContext,
) =>
  | EnvironmentPrincipal
  | undefined
  | Promise<EnvironmentPrincipal | undefined>;

export interface EnvironmentUpgradeOptions {
  readonly gateway: Gateway;
  readonly authenticateEnvironment: EnvironmentAuthenticator;
  readonly route?: string;
  readonly onConnected?: (details: {
    readonly principal: EnvironmentPrincipal;
    readonly connection: WebSocketEnvironmentConnection;
  }) => void;
  readonly onError?: (details: { readonly error: Error }) => void;
}

export interface EnvironmentUpgradeHandler {
  handle(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<boolean>;
  close(): Promise<void>;
}

interface ActiveEnvironment {
  readonly connection: WebSocketEnvironmentConnection;
  readonly registration: EnvironmentRegistration;
  ended: boolean;
}

class EnvironmentUpgradeHandlerModule implements EnvironmentUpgradeHandler {
  readonly #options: EnvironmentUpgradeOptions;
  readonly #route: string;
  readonly #webSockets = new WebSocketServer({ noServer: true });
  readonly #active = new Set<ActiveEnvironment>();
  #closed = false;

  constructor(options: EnvironmentUpgradeOptions) {
    this.#options = options;
    this.#route = options.route ?? '/environment';
  }

  async handle(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<boolean> {
    if (this.#closed)
      return rejectUpgrade(socket, 503, 'Gateway is shutting down');
    const path = new URL(request.url ?? '/', 'http://gateway').pathname;
    if (path !== this.#route) return rejectUpgrade(socket, 404, 'Not Found');

    let principal: EnvironmentPrincipal | undefined;
    try {
      principal = await this.#options.authenticateEnvironment({ request });
    } catch (cause) {
      this.#report(cause);
    }
    if (!principal) return rejectUpgrade(socket, 401, 'Unauthorized');

    return new Promise<boolean>((resolve) => {
      this.#webSockets.handleUpgrade(request, socket, head, (webSocket) => {
        const connection = createWebSocketEnvironmentConnection(webSocket);
        let registration: EnvironmentRegistration;
        try {
          registration = this.#options.gateway.registerEnvironment(
            principal,
            connection,
          );
        } catch (cause) {
          this.#report(cause);
          void connection.close();
          resolve(false);
          return;
        }
        const active: ActiveEnvironment = {
          connection,
          registration,
          ended: false,
        };
        this.#active.add(active);
        connection.onClose((cause) => {
          void this.#remove(active, cause);
        });
        this.#options.onConnected?.({ principal, connection });
        resolve(true);
      });
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const active = [...this.#active];
    await Promise.allSettled(active.map((item) => this.#remove(item)));
    await new Promise<void>((resolve) =>
      this.#webSockets.close(() => resolve()),
    );
  }

  async #remove(active: ActiveEnvironment, cause?: Error): Promise<void> {
    if (active.ended) return;
    active.ended = true;
    this.#active.delete(active);
    if (cause) this.#report(cause);
    await Promise.allSettled([
      active.registration.close(),
      active.connection.close(),
    ]);
  }

  #report(cause: unknown): void {
    this.#options.onError?.({
      error: cause instanceof Error ? cause : new Error(String(cause)),
    });
  }
}

export function createEnvironmentUpgradeHandler(
  options: EnvironmentUpgradeOptions,
): EnvironmentUpgradeHandler {
  return new EnvironmentUpgradeHandlerModule(options);
}

function rejectUpgrade(socket: Duplex, status: number, message: string): false {
  socket.end(
    `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  return false;
}
