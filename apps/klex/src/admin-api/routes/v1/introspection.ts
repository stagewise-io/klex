import {
  createRoute,
  type OpenAPIHono,
  type RouteHandler,
} from '@hono/zod-openapi';

import type { Introspector } from '@/introspection';

import {
  errorResponseSchema,
  introspectionNodeSchema,
  introspectionPathParamsSchema,
} from './schemas';

export interface IntrospectionRouteDependencies {
  introspector: Introspector;
}

// --- Root route: GET /v1/introspect ---

export const introspectionRootRoute = createRoute({
  method: 'get',
  path: '/v1/introspect',
  tags: ['Introspection'],
  summary: 'Read introspection tree root',
  description:
    'Returns the root node of the introspection tree — its state (if any) and direct children.',
  responses: {
    200: {
      content: {
        'application/json': { schema: introspectionNodeSchema },
      },
      description: 'Root introspection node with state and children',
    },
    500: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Internal server error (e.g. state function threw)',
    },
  },
});

export function getIntrospectionRoot(
  deps: IntrospectionRouteDependencies,
): RouteHandler<typeof introspectionRootRoute> {
  // biome-ignore lint/suspicious/noExplicitAny: RouteHandler generic causes TS2589 type instantiation depth exceeded
  return (async (c: any) => {
    const node = await deps.introspector.readGreedy([]);

    if (node === undefined) {
      return c.json({ error: 'Introspection root not found' }, 500);
    }

    return c.json(node, 200);
  }) as RouteHandler<typeof introspectionRootRoute>;
}

// --- Path route: GET /v1/introspect/:path{.+} ---
//
// We cannot use createRoute + app.openapi here because @hono/zod-openapi
// converts {path} → :path, which only captures a single URL segment. We need
// Hono's :path{.+} regex pattern to capture the full remaining path with
// slashes. Instead we register the OpenAPI spec manually and mount the Hono
// route directly.

export const introspectionPathClientRoute = createRoute({
  method: 'get',
  path: '/v1/introspect/{path}',
  tags: ['Introspection'],
  summary: 'Read introspection tree node at path',
  request: { params: introspectionPathParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: introspectionNodeSchema } },
      description: 'Introspection node with state and children',
    },
    400: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Path parameter is required',
    },
    404: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Path not found in introspection tree',
    },
    500: {
      content: { 'application/json': { schema: errorResponseSchema } },
      description: 'Internal server error',
    },
  },
});

export const introspectionPathRouteSpec = {
  method: 'get' as const,
  path: '/v1/introspect/{path}',
  tags: ['Introspection'],
  summary: 'Read introspection tree node at path',
  description:
    "Resolves a path in the introspection tree and returns the node at that path — its own state (if any) and a list of direct children (id, hasState, hasChildren). To read a child's state, navigate to that child's path. Use plain slashes for hierarchy (e.g. `sessions/sess-001/extensions/io.stagewise%2Fcontext-compaction`). URL-encode slashes that are part of an individual segment ID (e.g. `io.stagewise%2Fcontext-compaction`)",
  request: {
    params: introspectionPathParamsSchema,
  },
  responses: {
    200: {
      content: {
        'application/json': { schema: introspectionNodeSchema },
      },
      description: 'Introspection node with state and children',
    },
    404: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Path not found in introspection tree',
    },
    500: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Internal server error (e.g. state function threw)',
    },
  },
};

/**
 * Registers both the OpenAPI spec entry and the Hono route for
 * `GET /v1/introspect/:path{.+}`.
 *
 * Hono's `:path{.+}` regex pattern captures everything after
 * `/v1/introspect/` including slashes, while still being a named param
 * accessible via `c.req.param('path')`. We skip zValidator because the
 * wildcard param key doesn't map to the Zod schema's field name —
 * validation is a trivial non-empty check done inline.
 */
export function registerIntrospectionPathRoute(app: OpenAPIHono): void {
  app.openAPIRegistry.registerPath(introspectionPathRouteSpec);
}

export function getIntrospectionPathHandler(
  deps: IntrospectionRouteDependencies,
): RouteHandler<typeof introspectionPathClientRoute> {
  return async (c) => {
    const rawPath = c.req.param('path');

    if (!rawPath) {
      return c.json({ error: 'Path parameter is required' }, 400);
    }

    // Split on '/' and filter empty segments. Greedy resolution in the
    // introspector handles child IDs that themselves contain slashes
    // (e.g. "io.stagewise/context-compaction").
    const segments = rawPath.split('/').filter((s) => s.length > 0);

    const node = await deps.introspector.readGreedy(segments);

    if (node === undefined) {
      return c.json(
        { error: `Introspection path not found: ${segments.join('/')}` },
        404,
      );
    }

    return c.json(node, 200);
  };
}
