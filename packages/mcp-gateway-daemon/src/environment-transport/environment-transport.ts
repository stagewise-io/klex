import type {
  JSONRPCMessage,
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/server';

import {
  GATEWAY_PROTOCOL_VERSION,
  type GatewayMessageOptions,
  type GatewaySessionId,
  type SessionMessageFrame,
} from '@stagewise/mcp-gateway-core';

export interface EnvironmentTransport extends Transport {
  receive(message: JSONRPCMessage, options?: GatewayMessageOptions): void;
}

class EnvironmentTransportModule implements EnvironmentTransport {
  readonly sessionId: string;
  readonly #gatewaySessionId: GatewaySessionId;
  readonly #sendFrame: (frame: SessionMessageFrame) => Promise<void>;
  readonly #buffer: JSONRPCMessage[] = [];
  #started = false;
  #closed = false;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(
    sessionId: GatewaySessionId,
    sendFrame: (frame: SessionMessageFrame) => Promise<void>,
  ) {
    this.sessionId = sessionId;
    this.#gatewaySessionId = sessionId;
    this.#sendFrame = sendFrame;
  }

  async start(): Promise<void> {
    if (this.#closed) throw new Error('Transport is closed');
    if (this.#started) return;
    this.#started = true;
    for (const message of this.#buffer.splice(0)) this.onmessage?.(message);
  }

  async send(
    message: JSONRPCMessage,
    options?: TransportSendOptions,
  ): Promise<void> {
    if (!this.#started || this.#closed)
      throw new Error('Transport is not active');
    try {
      await this.#sendFrame({
        version: GATEWAY_PROTOCOL_VERSION,
        type: 'session.message',
        sessionId: this.#gatewaySessionId,
        message,
        ...(options?.relatedRequestId !== undefined
          ? { options: { relatedRequestId: options.relatedRequestId } }
          : {}),
      });
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.onerror?.(error);
      await this.close();
      throw error;
    }
  }

  receive(message: JSONRPCMessage, _options?: GatewayMessageOptions): void {
    if (this.#closed) return;
    if (!this.#started) this.#buffer.push(message);
    else this.onmessage?.(message);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#buffer.length = 0;
    this.onclose?.();
  }
}

export function createEnvironmentTransport(
  sessionId: GatewaySessionId,
  sendFrame: (frame: SessionMessageFrame) => Promise<void>,
): EnvironmentTransport {
  return new EnvironmentTransportModule(sessionId, sendFrame);
}
