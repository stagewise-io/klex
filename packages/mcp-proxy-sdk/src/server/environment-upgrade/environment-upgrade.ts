import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import { WebSocketServer } from 'ws';

import type {
  EnvironmentId,
  EnvironmentRegistration,
  McpProxy,
} from '../../core/index.js';
import {
  createWebSocketEnvironmentConnection,
  type WebSocketEnvironmentConnection,
} from '../websocket-environment-connection/index.js';

export interface EnvironmentUpgradeContext {
  readonly request: IncomingMessage;
}

export type EnvironmentAuthenticator = (
  context: EnvironmentUpgradeContext,
) => EnvironmentId | undefined | Promise<EnvironmentId | undefined>;

export interface EnvironmentUpgradeOptions {
  readonly proxy: McpProxy;
  readonly authenticateEnvironment: EnvironmentAuthenticator;
  readonly route?: string;
  readonly onConnected?: (details: {
    readonly environmentId: EnvironmentId;
    readonly connection: WebSocketEnvironmentConnection;
  }) => void | Promise<void>;
  readonly onDisconnected?: (details: {
    readonly environmentId: EnvironmentId;
    readonly connection: WebSocketEnvironmentConnection;
    readonly cause?: Error;
  }) => void | Promise<void>;
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
  readonly environmentId: EnvironmentId;
  readonly connection: WebSocketEnvironmentConnection;
  readonly registration: EnvironmentRegistration;
  ready: Promise<void>;
  connected: boolean;
  removal?: Promise<void>;
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
      return rejectUpgrade(socket, 503, 'Proxy is shutting down');
    const path = new URL(request.url ?? '/', 'http://proxy').pathname;
    if (path !== this.#route) return rejectUpgrade(socket, 404, 'Not Found');

    let environmentId: EnvironmentId | undefined;
    try {
      environmentId = await this.#options.authenticateEnvironment({ request });
    } catch (cause) {
      this.#report(cause);
    }
    if (!environmentId) return rejectUpgrade(socket, 401, 'Unauthorized');

    return new Promise<boolean>((resolve) => {
      this.#webSockets.handleUpgrade(request, socket, head, (webSocket) => {
        const connection = createWebSocketEnvironmentConnection(webSocket);
        let registration: EnvironmentRegistration;
        try {
          registration = this.#options.proxy.registerEnvironment(
            environmentId,
            connection,
          );
        } catch (cause) {
          this.#report(cause);
          void connection.close();
          resolve(false);
          return;
        }
        const active: ActiveEnvironment = {
          environmentId,
          connection,
          registration,
          ready: Promise.resolve(),
          connected: false,
        };
        this.#active.add(active);
        connection.onClose((cause) => {
          void this.#remove(active, cause);
        });
        active.ready = Promise.resolve(
          this.#options.onConnected?.({ environmentId, connection }),
        ).then(() => {
          active.connected = true;
        });
        void active.ready.then(
          () => resolve(!active.removal),
          async (cause) => {
            this.#report(cause);
            await this.#remove(active, cause);
            resolve(false);
          },
        );
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
    if (active.removal) return active.removal;
    active.removal = this.#finishRemove(active, cause);
    return active.removal;
  }

  async #finishRemove(active: ActiveEnvironment, cause?: Error): Promise<void> {
    await active.ready.catch(() => undefined);
    if (cause) this.#report(cause);
    await Promise.allSettled([
      active.registration.close(),
      active.connection.close(),
    ]);
    if (active.connected) {
      try {
        await this.#options.onDisconnected?.({
          environmentId: active.environmentId,
          connection: active.connection,
          ...(cause ? { cause } : {}),
        });
      } catch (disconnectCause) {
        this.#report(disconnectCause);
      }
    }
    this.#active.delete(active);
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
