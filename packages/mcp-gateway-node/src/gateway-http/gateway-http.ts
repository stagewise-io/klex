import { randomUUID } from 'node:crypto';

import {
  classifyInboundRequest,
  type InboundHttpRequest,
  PerRequestHTTPServerTransport,
  WebStandardStreamableHTTPServerTransport,
} from '@modelcontextprotocol/server';

import type {
  AgentPrincipal,
  EnvironmentId,
  Gateway,
  GatewaySession,
  Unsubscribe,
} from '@stagewise/mcp-gateway-core';

export interface GatewayHttpRequestContext {
  readonly request: Request;
}

export type AgentAuthenticator = (
  context: GatewayHttpRequestContext,
) => AgentPrincipal | undefined | Promise<AgentPrincipal | undefined>;

export interface GatewayHttpHooks {
  readonly onSessionOpened?: (details: {
    readonly gatewaySessionId: string;
    readonly environmentId: EnvironmentId;
    readonly kind: 'legacy' | 'modern';
  }) => void;
  readonly onSessionClosed?: (details: {
    readonly gatewaySessionId: string;
    readonly cause?: Error;
  }) => void;
  readonly onError?: (details: { readonly error: Error }) => void;
}

export interface GatewayHttpOptions {
  readonly gateway: Gateway;
  readonly authenticateAgent: AgentAuthenticator;
  readonly parseEnvironmentId: (value: string) => EnvironmentId;
  readonly routePrefix?: string;
  readonly hooks?: GatewayHttpHooks;
}

export interface GatewayHttp {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
  readonly sessionCount: number;
}

interface LegacyBinding {
  readonly transport: WebStandardStreamableHTTPServerTransport;
  readonly session: GatewaySession;
  readonly unsubscribe: Unsubscribe[];
  ended: boolean;
}

class GatewayHttpModule implements GatewayHttp {
  readonly #options: GatewayHttpOptions;
  readonly #routePrefix: string;
  readonly #legacy = new Map<string, LegacyBinding>();
  readonly #modern = new Set<GatewaySession>();
  #closed = false;

  constructor(options: GatewayHttpOptions) {
    this.#options = options;
    this.#routePrefix = options.routePrefix ?? '/environments/';
  }

  get sessionCount(): number {
    return this.#legacy.size + this.#modern.size;
  }

  async fetch(request: Request): Promise<Response> {
    if (this.#closed) return jsonError(503, 'Gateway HTTP handler is closed');
    const environmentId = this.#environmentId(request);
    if (!environmentId) return new Response(null, { status: 404 });
    let agent: AgentPrincipal | undefined;
    try {
      agent = await this.#options.authenticateAgent({ request });
    } catch (cause) {
      this.#report(cause);
      return jsonError(401, 'Unauthorized');
    }
    if (!agent) return jsonError(401, 'Unauthorized');

    const bodyResult = await readJsonBody(request);
    if (bodyResult instanceof Response) return bodyResult;
    const inbound: InboundHttpRequest = {
      httpMethod: request.method,
      ...(request.headers.get('mcp-protocol-version')
        ? {
            protocolVersionHeader:
              request.headers.get('mcp-protocol-version') ?? undefined,
          }
        : {}),
      ...(request.headers.get('mcp-method')
        ? { mcpMethodHeader: request.headers.get('mcp-method') ?? undefined }
        : {}),
      ...(request.headers.get('mcp-name')
        ? { mcpNameHeader: request.headers.get('mcp-name') ?? undefined }
        : {}),
      ...(bodyResult !== undefined ? { body: bodyResult } : {}),
    };
    const classification = classifyInboundRequest(inbound);
    if (classification.kind === 'reject') {
      return Response.json(
        {
          jsonrpc: '2.0',
          id: null,
          error: {
            code: classification.code,
            message: classification.message,
            ...(classification.data !== undefined
              ? { data: classification.data }
              : {}),
          },
        },
        { status: classification.httpStatus },
      );
    }
    if (classification.kind === 'modern') {
      return this.#modernRequest(
        request,
        bodyResult,
        classification,
        agent,
        environmentId,
      );
    }
    return this.#legacyRequest(request, bodyResult, agent, environmentId);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const legacy = [...this.#legacy.values()];
    const modern = [...this.#modern];
    this.#legacy.clear();
    this.#modern.clear();
    await Promise.allSettled([
      ...legacy.flatMap((binding) => [
        binding.transport.close(),
        binding.session.close(),
      ]),
      ...modern.map((session) => session.close()),
    ]);
  }

  async #legacyRequest(
    request: Request,
    body: unknown,
    agent: AgentPrincipal,
    environmentId: EnvironmentId,
  ): Promise<Response> {
    const sessionId = request.headers.get('mcp-session-id');
    if (sessionId) {
      const binding = this.#legacy.get(sessionId);
      if (!binding) return jsonError(404, 'Unknown MCP session');
      return binding.transport.handleRequest(request, { parsedBody: body });
    }
    if (request.method !== 'POST') {
      const transport = new WebStandardStreamableHTTPServerTransport();
      await transport.start();
      const response = await transport.handleRequest(request, {
        parsedBody: body,
      });
      await transport.close();
      return response;
    }

    let session: GatewaySession;
    try {
      session = await this.#options.gateway.openSession(agent, environmentId, {
        signal: request.signal,
      });
    } catch (cause) {
      this.#report(cause);
      return jsonError(503, errorMessage(cause));
    }
    const generatedId = randomUUID();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => generatedId,
      onsessionclosed: () => this.#removeLegacy(generatedId),
    });
    const binding: LegacyBinding = {
      transport,
      session,
      unsubscribe: [],
      ended: false,
    };
    binding.unsubscribe.push(
      session.onMessage(
        (message, options) =>
          void transport.send(message, options).catch((cause) => {
            this.#report(cause);
            void this.#removeLegacy(generatedId, cause);
          }),
      ),
      session.onClose((cause) => {
        void this.#removeLegacy(generatedId, cause, false);
      }),
    );
    transport.onmessage = (message) => {
      void session.send(message).catch((cause) => {
        this.#report(cause);
        void this.#removeLegacy(generatedId, cause);
      });
    };
    transport.onerror = (error) => this.#report(error);
    this.#legacy.set(generatedId, binding);
    this.#opened(session, environmentId, 'legacy');
    try {
      await transport.start();
      const response = await transport.handleRequest(request, {
        parsedBody: body,
      });
      if (!transport.sessionId) await this.#removeLegacy(generatedId);
      return response;
    } catch (cause) {
      await this.#removeLegacy(generatedId, cause);
      return jsonError(502, errorMessage(cause));
    }
  }

  async #modernRequest(
    request: Request,
    _body: unknown,
    classification: Extract<
      ReturnType<typeof classifyInboundRequest>,
      { kind: 'modern' }
    >,
    agent: AgentPrincipal,
    environmentId: EnvironmentId,
  ): Promise<Response> {
    let session: GatewaySession;
    try {
      session = await this.#options.gateway.openSession(agent, environmentId, {
        signal: request.signal,
      });
    } catch (cause) {
      this.#report(cause);
      return jsonError(503, errorMessage(cause));
    }
    this.#modern.add(session);
    const transport = new PerRequestHTTPServerTransport({
      classification: classification.classification,
    });
    let ended = false;
    const finish = async (cause?: unknown, closeSession = true) => {
      if (ended) return;
      ended = true;
      this.#modern.delete(session);
      unsubscribe();
      await transport.close().catch(() => undefined);
      if (closeSession) await session.close().catch(() => undefined);
      this.#closedHook(session, cause);
    };
    const unsubscribe = session.onClose((cause) => {
      void finish(cause, false);
    });
    session.onMessage((message, options) => {
      void transport.send(message, options).catch((cause) => finish(cause));
    });
    transport.onmessage = (message) => {
      void session.send(message).catch((cause) => finish(cause));
    };
    transport.onerror = (error) => this.#report(error);
    this.#opened(session, environmentId, 'modern');
    try {
      await transport.start();
      const response = await transport.handleMessage(classification.message, {
        request,
      });
      return wrapResponse(response, () => finish());
    } catch (cause) {
      await finish(cause);
      return jsonError(502, errorMessage(cause));
    }
  }

  async #removeLegacy(
    id: string,
    cause?: unknown,
    closeSession = true,
  ): Promise<void> {
    const binding = this.#legacy.get(id);
    if (!binding || binding.ended) return;
    binding.ended = true;
    this.#legacy.delete(id);
    for (const unsubscribe of binding.unsubscribe) unsubscribe();
    await binding.transport.close().catch(() => undefined);
    if (closeSession) await binding.session.close().catch(() => undefined);
    this.#closedHook(binding.session, cause);
  }

  #environmentId(request: Request): EnvironmentId | undefined {
    const path = new URL(request.url).pathname;
    if (!path.startsWith(this.#routePrefix) || !path.endsWith('/mcp')) return;
    const value = path.slice(this.#routePrefix.length, -'/mcp'.length);
    if (!value || value.includes('/')) return;
    try {
      return this.#options.parseEnvironmentId(decodeURIComponent(value));
    } catch {
      return;
    }
  }

  #opened(
    session: GatewaySession,
    environmentId: EnvironmentId,
    kind: 'legacy' | 'modern',
  ): void {
    this.#options.hooks?.onSessionOpened?.({
      gatewaySessionId: session.id,
      environmentId,
      kind,
    });
  }

  #closedHook(session: GatewaySession, cause?: unknown): void {
    this.#options.hooks?.onSessionClosed?.({
      gatewaySessionId: session.id,
      ...(cause !== undefined ? { cause: asError(cause) } : {}),
    });
  }

  #report(cause: unknown): void {
    this.#options.hooks?.onError?.({ error: asError(cause) });
  }
}

export function createGatewayHttp(options: GatewayHttpOptions): GatewayHttp {
  return new GatewayHttpModule(options);
}

async function readJsonBody(request: Request): Promise<unknown | Response> {
  if (request.method !== 'POST') return;
  if (!request.headers.get('content-type')?.includes('application/json')) {
    return jsonError(415, 'Expected application/json');
  }
  try {
    return await request.clone().json();
  } catch {
    return jsonError(400, 'Invalid JSON body');
  }
}

function wrapResponse(
  response: Response,
  finish: () => Promise<void>,
): Response {
  if (!response.body) {
    void finish();
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          await finish();
        } else controller.enqueue(result.value);
      } catch (cause) {
        controller.error(cause);
        await finish();
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
      await finish();
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function jsonError(status: number, message: string): Response {
  return Response.json(
    { jsonrpc: '2.0', id: null, error: { code: -32_000, message } },
    { status },
  );
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function errorMessage(cause: unknown): string {
  return asError(cause).message;
}
