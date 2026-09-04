import { createRoute, type RouteHandler } from '@hono/zod-openapi';

import type { ModuleLogger } from '@stagewise/logger';

import type { Mcp } from '@/mcp';

import {
  errorResponseSchema,
  oauthCallbackAcceptedSchema,
  oauthCallbackBodySchema,
  pendingAuthorizationIdParamSchema,
  pendingAuthorizationsResponseSchema,
  startAuthorizationBodySchema,
  startAuthorizationResponseSchema,
} from './schemas';

export interface McpOAuthRouteDependencies {
  mcp: Mcp;
  logger: ModuleLogger;
}

// --- GET /v1/mcp-oauth/pending ---

export const getPendingAuthorizationsRoute = createRoute({
  method: 'get',
  path: '/v1/mcp-oauth/pending',
  tags: ['MCP OAuth'],
  summary: 'List pending MCP OAuth authorizations',
  description:
    'Returns the MCP OAuth authorizations that are currently waiting for a cloud-delivered callback. Authorization URLs and the OAuth "state" are never included: "state" is the capability that authorizes a callback. Pending authorizations are held in memory and are lost when the agent restarts.',
  responses: {
    200: {
      content: {
        'application/json': { schema: pendingAuthorizationsResponseSchema },
      },
      description: 'Pending authorizations',
    },
  },
});

export function getPendingAuthorizations(
  deps: McpOAuthRouteDependencies,
): RouteHandler<typeof getPendingAuthorizationsRoute> {
  return (c) => {
    return c.json(
      { authorizations: deps.mcp.listPendingAuthorizations() },
      200,
    );
  };
}

// --- POST /v1/mcp-oauth/authorizations ---

export const startAuthorizationRoute = createRoute({
  method: 'post',
  path: '/v1/mcp-oauth/authorizations',
  tags: ['MCP OAuth'],
  summary: 'Start a cloud-relayed MCP OAuth authorization',
  description:
    'Drives a connection attempt for the named MCP server until it produces an authorization URL, then returns that URL together with the OAuth "state" to the caller. Repeat calls for a server with a live pending authorization return the existing one instead of restarting the flow. Requires an enrolled agent with a connected Klex Cloud tunnel.',
  request: {
    body: {
      content: {
        'application/json': { schema: startAuthorizationBodySchema },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        'application/json': { schema: startAuthorizationResponseSchema },
      },
      description: 'Authorization is pending user consent',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'MCP server not found',
    },
    409: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'MCP server does not use interactive OAuth',
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
  deps: McpOAuthRouteDependencies,
): RouteHandler<typeof startAuthorizationRoute> {
  return async (c) => {
    const { serverName } = c.req.valid('json');
    const result = await deps.mcp.requestAuthorization(serverName);

    // Never log `state` or the authorization URL: both are bearer capabilities.
    deps.logger.info(
      { serverName, outcome: result.outcome },
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
        return c.json({ error: 'MCP server not found' }, 404);
      case 'not_applicable':
        return c.json({ error: result.reason }, 409);
      case 'unavailable':
        return c.json(
          { error: 'Cloud authorization channel is unavailable' },
          503,
        );
      case 'timeout':
        return c.json(
          { error: 'MCP server did not request authorization in time' },
          504,
        );
    }
  };
}

// --- POST /v1/mcp-oauth/callback ---

export const completeAuthorizationRoute = createRoute({
  method: 'post',
  path: '/v1/mcp-oauth/callback',
  tags: ['MCP OAuth'],
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
  deps: McpOAuthRouteDependencies,
): RouteHandler<typeof completeAuthorizationRoute> {
  return (c) => {
    const body = c.req.valid('json');
    if (!body.code && !body.error) {
      return c.json(
        { error: 'Callback must include either "code" or "error"' },
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
      return c.json({ error: 'No pending authorization for this state' }, 404);
    }
    return c.json({ accepted: true as const }, 202);
  };
}

// --- DELETE /v1/mcp-oauth/authorizations/{id} ---

export const cancelAuthorizationRoute = createRoute({
  method: 'delete',
  path: '/v1/mcp-oauth/authorizations/{id}',
  tags: ['MCP OAuth'],
  summary: 'Cancel a pending MCP OAuth authorization',
  description:
    'Aborts the parked connection attempt. The MCP server returns to the authorization_required state.',
  request: {
    params: pendingAuthorizationIdParamSchema,
  },
  responses: {
    204: { description: 'Authorization canceled' },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Unknown authorization id',
    },
  },
});

export function cancelAuthorization(
  deps: McpOAuthRouteDependencies,
): RouteHandler<typeof cancelAuthorizationRoute> {
  return (c) => {
    const { id } = c.req.valid('param');
    const canceled = deps.mcp.cancelAuthorization(id);
    deps.logger.info({ canceled }, 'MCP OAuth authorization cancel requested');
    if (!canceled) {
      return c.json({ error: 'Pending authorization not found' }, 404);
    }
    return c.body(null, 204);
  };
}
