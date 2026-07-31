import type { RawData, WebSocket } from 'ws';

import {
  decodeEnvironmentToProxyFrame,
  type EnvironmentConnection,
  type EnvironmentToProxyFrame,
  encodeProxyFrame,
  type ProxyToEnvironmentFrame,
  type Unsubscribe,
} from '../../core/index.js';

export interface WebSocketEnvironmentConnection extends EnvironmentConnection {}

class WebSocketEnvironmentConnectionModule
  implements WebSocketEnvironmentConnection
{
  readonly #socket: WebSocket;
  readonly #frameHandlers = new Set<(frame: EnvironmentToProxyFrame) => void>();
  readonly #closeHandlers = new Set<(cause?: Error) => void>();
  #sendChain = Promise.resolve();
  #closed = false;

  constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.on('message', this.#handleMessage);
    socket.once('close', this.#handleSocketClose);
    socket.once('error', this.#handleSocketError);
  }

  send(frame: ProxyToEnvironmentFrame): Promise<void> {
    if (this.#closed) return Promise.reject(new Error('Connection is closed'));
    const operation = this.#sendChain.then(
      () =>
        new Promise<void>((resolve, reject) => {
          if (this.#closed || this.#socket.readyState !== this.#socket.OPEN) {
            reject(new Error('Connection is closed'));
            return;
          }
          this.#socket.send(encodeProxyFrame(frame), (error) => {
            if (error) reject(error);
            else resolve();
          });
        }),
    );
    this.#sendChain = operation.catch(() => undefined);
    return operation;
  }

  onFrame(handler: (frame: EnvironmentToProxyFrame) => void): Unsubscribe {
    this.#frameHandlers.add(handler);
    return () => this.#frameHandlers.delete(handler);
  }

  onClose(handler: (cause?: Error) => void): Unsubscribe {
    this.#closeHandlers.add(handler);
    return () => this.#closeHandlers.delete(handler);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    if (this.#socket.readyState === this.#socket.CLOSED) {
      this.#finish();
      return;
    }
    const closed = new Promise<void>((resolve) =>
      this.#socket.once('close', () => resolve()),
    );
    this.#socket.close();
    await closed;
  }

  readonly #handleMessage = (data: RawData, isBinary: boolean): void => {
    if (this.#closed) return;
    try {
      if (isBinary) throw new Error('Binary proxy frames are unsupported');
      const frame = decodeEnvironmentToProxyFrame(data.toString('utf8'));
      for (const handler of this.#frameHandlers) handler(frame);
    } catch (cause) {
      this.#fail(cause instanceof Error ? cause : new Error(String(cause)));
    }
  };

  readonly #handleSocketError = (cause: Error): void => this.#fail(cause);
  readonly #handleSocketClose = (): void => this.#finish();

  #fail(cause: Error): void {
    if (this.#closed) return;
    this.#finish(cause);
    this.#socket.close(1002, 'Invalid proxy frame');
  }

  #finish(cause?: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket.off('message', this.#handleMessage);
    this.#socket.off('error', this.#handleSocketError);
    this.#socket.off('close', this.#handleSocketClose);
    for (const handler of this.#closeHandlers) handler(cause);
    this.#frameHandlers.clear();
    this.#closeHandlers.clear();
  }
}

export function createWebSocketEnvironmentConnection(
  socket: WebSocket,
): WebSocketEnvironmentConnection {
  return new WebSocketEnvironmentConnectionModule(socket);
}
