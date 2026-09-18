import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import type { z } from 'zod/v4';

import { AttioError, safeError } from './errors.js';
import type { AttioService } from './service.js';
import type { Principal } from './store.js';
import { descriptions, type ToolName, toolSchemas } from './tools.js';

export interface Authenticator {
  /** Verify Klex credentials cryptographically; never accept Attio tokens or caller-asserted IDs. */
  authenticate(request: Request): Promise<Principal | undefined>;
}
/** Stateless official SDK handler. A request-local server closes over one verified
 * principal and connection; no session or handler cache can cross that boundary.
 */
export function createAttioHttp(service: AttioService, auth: Authenticator) {
  return {
    async fetch(request: Request): Promise<Response> {
      let handler: ReturnType<typeof createMcpHandler> | undefined;
      try {
        const path = new URL(request.url).pathname.match(
          /^\/connections\/([a-f0-9-]{36})\/mcp$/,
        );
        if (!path?.[1]) return new Response(null, { status: 404 });
        const id = path[1];
        const principal = await auth.authenticate(request);
        if (!principal) throw new AttioError('UNAUTHORIZED');
        await service.status(principal, id);
        if (request.method !== 'POST')
          return new Response(null, {
            status: 405,
            headers: { Allow: 'POST' },
          });
        // Bound the body before the SDK parses JSON, including chunked requests.
        const reader = request.body?.getReader();
        if (!reader) throw new AttioError('INVALID_INPUT');
        let size = 0;
        const chunks: Uint8Array[] = [];
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > 131_072) throw new AttioError('INVALID_INPUT');
            chunks.push(part.value);
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
        handler = createMcpHandler(
          () => {
            const server = new McpServer(
              { name: 'attio', version: '0.1.0' },
              { capabilities: {} },
            );
            for (const name of Object.keys(toolSchemas) as ToolName[]) {
              const read = [
                'query_records',
                'search_records',
                'get_record',
              ].includes(name);
              server.registerTool(
                name,
                {
                  description: descriptions[name],
                  inputSchema: toolSchemas[name] as z.ZodObject,
                  annotations: {
                    readOnlyHint: read,
                    destructiveHint: !read,
                    idempotentHint: read,
                    openWorldHint: true,
                  },
                },
                async (input) => {
                  try {
                    const result = await service.execute(
                      principal,
                      id,
                      name,
                      input,
                    );
                    return {
                      content: [{ type: 'text', text: JSON.stringify(result) }],
                      structuredContent: result,
                    };
                  } catch (error) {
                    const result = safeError(error);
                    return {
                      isError: true,
                      content: [{ type: 'text', text: JSON.stringify(result) }],
                      structuredContent: result,
                    };
                  }
                },
              );
            }
            return server;
          },
          { legacy: 'stateless' },
        );
        const response = await handler.fetch(
          new Request(request.url, {
            method: 'POST',
            headers: request.headers,
            body: Buffer.concat(chunks),
          }),
        );
        // Drain the bounded response before closing its request-local handler.
        const body = await response.arrayBuffer();
        return new Response(body, {
          status: response.status,
          headers: {
            ...Object.fromEntries(response.headers),
            'Cache-Control': 'no-store',
          },
        });
      } catch (error) {
        const result = safeError(error);
        return Response.json(result, {
          status:
            result.code === 'UNAUTHORIZED'
              ? 401
              : result.code === 'NOT_FOUND'
                ? 404
                : result.code === 'INVALID_INPUT'
                  ? 400
                  : 503,
          headers: { 'Cache-Control': 'no-store' },
        });
      } finally {
        await handler?.close();
      }
    },
  };
}
