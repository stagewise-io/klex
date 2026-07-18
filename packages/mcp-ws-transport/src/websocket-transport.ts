import type { WebSocket } from 'ws';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/**
 * MCP `Transport` implementation over a `ws` WebSocket.
 *
 * Symmetric — the same class is used on both sides:
 * - Orchestrator wraps the server-side WS (MCP client role).
 * - Environment wraps the client-side WS (MCP server role).
 *
 * The `ws` WebSocket must already be connected (readyState OPEN) when
 * the transport is created. `start()` wires up event listeners.
 */
export class WebSocketTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  sessionId?: string;
  setProtocolVersion?: (version: string) => void;

  #ws: WebSocket;
  #started = false;

  constructor(ws: WebSocket) {
    this.#ws = ws;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;

    this.#ws.on('message', (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString()) as JSONRPCMessage;
        this.onmessage?.(message);
      } catch (err) {
        this.onerror?.(err as Error);
      }
    });

    this.#ws.on('close', () => {
      this.onclose?.();
    });

    this.#ws.on('error', (err: Error) => {
      this.onerror?.(err);
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.#ws.readyState !== this.#ws.OPEN) {
      throw new Error('WebSocket is not open');
    }
    this.#ws.send(JSON.stringify(message));
  }

  async close(): Promise<void> {
    if (this.#ws.readyState === this.#ws.CLOSED) {
      return;
    }
    // Wait for the 'close' event to fire before resolving.
    // This ensures the MCP SDK's _onclose() runs within the await chain,
    // preventing unhandled rejections from pending response handlers.
    const closePromise = new Promise<void>((resolve) => {
      this.#ws.once('close', resolve);
    });
    this.#ws.close();
    await closePromise;
  }
}
