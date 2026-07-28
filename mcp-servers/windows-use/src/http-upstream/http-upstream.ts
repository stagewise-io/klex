import type { GatewayEnvironmentHandler } from '@stagewise/mcp-gateway-sdk/daemon/node';

export interface HttpUpstreamOptions {
  readonly url: URL | string;
  readonly fetch?: typeof globalThis.fetch;
}

export type HttpUpstream = GatewayEnvironmentHandler;

class HttpUpstreamModule implements HttpUpstream {
  readonly #url: URL;
  readonly #fetch: typeof globalThis.fetch;
  #closed = false;

  constructor(options: HttpUpstreamOptions) {
    this.#url = new URL(options.url);
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async fetch(request: Request): Promise<Response> {
    if (this.#closed) {
      return new Response('Windows-MCP upstream is unavailable', {
        status: 503,
      });
    }

    try {
      return await this.#fetch(
        new Request(this.#url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          signal: request.signal,
          ...(request.body ? { duplex: 'half' } : {}),
        }),
      );
    } catch (error) {
      if (request.signal.aborted) throw error;
      return new Response('Windows-MCP upstream is unavailable', {
        status: 503,
      });
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
  }
}

export function createHttpUpstream(options: HttpUpstreamOptions): HttpUpstream {
  return new HttpUpstreamModule(options);
}
