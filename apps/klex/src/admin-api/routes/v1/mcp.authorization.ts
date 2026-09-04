import { createRoute, type RouteHandler } from '@hono/zod-openapi';

import type { ModuleLogger } from '@stagewise/logger';

import type { Mcp } from '@/mcp';

import {
  errorResponseSchema,
  mcpServerAuthorizationStartedSchema,
  mcpServerNameParamSchema,
  oauthCallbackAcceptedSchema,
  oauthCallbackBodySchema,
} from './schemas';

export interface McpAuthorizationRouteDependencies {
  mcp: Mcp;
  logger: ModuleLogger;
}

// --- PUT /v1/mcp-servers/{name}/authorization ---

export const startAuthorizationRoute = createRoute({
  method: 'put',
  path: '/v1/mcp-servers/{name}/authorization',
  tags: ['MCP Servers'],
  summary: 'Start or reuse a cloud-relayed MCP OAuth authorization',
  description:
    'Drives a connection attempt for the named MCP server until it produces an authorization URL, then returns that URL together with the OAuth "state" to the caller. Idempotent: a server with a live pending authorization gets the existing one back instead of a restarted flow. The returned "state" and authorization URL appear in no other response — poll GET /v1/mcp-servers/{name} for the authorization lifetime. Requires an enrolled agent with a connected Klex Cloud tunnel.',
  request: {
    params: mcpServerNameParamSchema,
  },
  responses: {
    200: {
      content: {
        'application/json': { schema: mcpServerAuthorizationStartedSchema },
      },
      description: 'Authorization is pending user consent',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'MCP server not found',
    },
    409: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description:
        'MCP server cannot be authorized interactively, or needs no authorization',
    },
    503: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Cloud authorization channel unavailable',
    },
    504: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'No authorization URL was produced in time',
    },
  },
});

export function startAuthorization(
  deps: McpAuthorizationRouteDependencies,
): RouteHandler<typeof startAuthorizationRoute> {
  return async (c) => {
    const { name } = c.req.valid('param');
    const result = await deps.mcp.requestAuthorization(name);

    // Never log `state` or the authorization URL: both are bearer capabilities.
    deps.logger.info(
      { serverName: name, outcome: result.outcome },
      'MCP OAuth authorization requested',
    );

    switch (result.outcome) {
      case 'pending':
        return c.json(
          {
            id: result.authorization.id,
            serverName: result.authorization.serverName,
            serverUrl: result.authorization.serverUrl,
            authorizationUrl: result.authorization.authorizationUrl,
            state: result.authorization.state,
            expiresAt: result.authorization.expiresAt,
          },
          200,
        );
      case 'not_found':
        return c.json(
          { error: 'MCP server not found', code: 'server_not_found' },
          404,
        );
      case 'unsupported_transport':
        return c.json(
          {
            error: 'stdio MCP servers do not use OAuth',
            code: 'unsupported_transport',
          },
          409,
        );
      case 'manual_credentials':
        return c.json(
          {
            error:
              'MCP server is configured with an explicit Authorization header',
            code: 'manual_credentials',
          },
          409,
        );
      case 'already_connected':
        return c.json(
          {
            error: 'MCP server is already connected',
            code: 'already_connected',
          },
          409,
        );
      case 'not_running':
        return c.json(
          { error: 'MCP module is not started', code: 'not_running' },
          503,
        );
      case 'unavailable':
        return c.json(
          {
            error: 'Cloud authorization channel is unavailable',
            code: 'cloud_unavailable',
          },
          503,
        );
      case 'timeout':
        return c.json(
          {
            error: 'MCP server did not request authorization in time',
            code: 'authorization_timeout',
          },
          504,
        );
    }
  };
}

// --- DELETE /v1/mcp-servers/{name}/authorization ---

export const cancelAuthorizationRoute = createRoute({
  method: 'delete',
  path: '/v1/mcp-servers/{name}/authorization',
  tags: ['MCP Servers'],
  summary: 'Cancel the pending MCP OAuth authorization of a server',
  description:
    'Aborts the parked connection attempt. The MCP server returns to the authorization_required state.',
  request: {
    params: mcpServerNameParamSchema,
  },
  responses: {
    204: { description: 'Authorization canceled' },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Server has no pending authorization',
    },
  },
});

export function cancelAuthorization(
  deps: McpAuthorizationRouteDependencies,
): RouteHandler<typeof cancelAuthorizationRoute> {
  return (c) => {
    const { name } = c.req.valid('param');
    const canceled = deps.mcp.cancelAuthorization(name);
    deps.logger.info(
      { serverName: name, canceled },
      'MCP OAuth authorization cancel requested',
    );
    if (!canceled) {
      return c.json(
        {
          error: 'Pending authorization not found',
          code: 'authorization_not_found',
        },
        404,
      );
    }
    return c.body(null, 204);
  };
}

// --- POST /v1/mcp-oauth/callback ---

// Deliberately outside the mcp-servers resource: the callback is keyed by
// `state`, arrives from a browser redirect relayed by the cloud, and must be
// servable without a server name. Its path is also a compatibility contract —
// `CLOUD_OAUTH_CALLBACK_PATH` is baked into dynamic client registrations.
export const completeAuthorizationRoute = createRoute({
  method: 'post',
  path: '/v1/mcp-oauth/callback',
  tags: ['MCP Servers'],
  summary: 'Deliver OAuth callback parameters',
  description:
    'Hands the parameters of an OAuth redirect back to the parked connection attempt identified by "state". The attempt performs the code exchange itself, so the PKCE verifier and any client secret never leave the agent. Single use: a replayed, expired or unknown "state" is answered with 404.',
  request: {
    body: {
      content: {
        'application/json': { schema: oauthCallbackBodySchema },
      },
      required: true,
    },
  },
  responses: {
    202: {
      content: {
        'application/json': { schema: oauthCallbackAcceptedSchema },
      },
      description: 'Callback accepted',
    },
    400: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Body carries neither a code nor an error',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Unknown, expired or already-consumed state',
    },
  },
});

export function completeAuthorization(
  deps: McpAuthorizationRouteDependencies,
): RouteHandler<typeof completeAuthorizationRoute> {
  return (c) => {
    const body = c.req.valid('json');
    if (!body.code && !body.error) {
      return c.json(
        {
          error: 'Callback must include either "code" or "error"',
          code: 'invalid_callback',
        },
        400,
      );
    }

    const params = new URLSearchParams();
    if (body.code) params.set('code', body.code);
    if (body.error) params.set('error', body.error);
    if (body.error_description)
      params.set('error_description', body.error_description);

    const outcome = deps.mcp.completeAuthorization(body.state, params);
    deps.logger.info({ outcome }, 'MCP OAuth callback delivered');
    if (outcome === 'unknown') {
      return c.json(
        {
          error: 'No pending authorization for this state',
          code: 'unknown_state',
        },
        404,
      );
    }
    return c.json({ accepted: true as const }, 202);
  };
}
