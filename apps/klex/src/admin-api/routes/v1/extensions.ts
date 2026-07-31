import { createRoute, type RouteHandler } from '@hono/zod-openapi';

import type { Router } from '@/router';

import {
  errorResponseSchema,
  extensionListParamSchema,
  extensionListResponseSchema,
  extensionStateParamSchema,
  extensionStateResponseSchema,
} from './schemas';

export interface ExtensionRouteDependencies {
  router: Router;
}

export const extensionStateRoute = createRoute({
  method: 'get',
  path: '/v1/sessions/{sessionId}/extensions/{extensionId}/state',
  tags: ['Extensions'],
  summary: 'Get extension state',
  description:
    'Returns the internal state of a single extension within a specific session. The extensionId must be URL-encoded if it contains slashes (e.g. io.stagewise%2Fcontext-compaction). Returns the bare JSON state object, or null if the extension does not implement introspection.',
  request: {
    params: extensionStateParamSchema,
  },
  responses: {
    200: {
      content: {
        'application/json': { schema: extensionStateResponseSchema },
      },
      description: 'Extension state (bare JSON object or null)',
    },
    404: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Session or extension not found',
    },
    500: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Internal server error',
    },
  },
});

export function getExtensionState(
  deps: ExtensionRouteDependencies,
): RouteHandler<typeof extensionStateRoute> {
  // biome-ignore lint/suspicious/noExplicitAny: RouteHandler generic causes TS2589 type instantiation depth exceeded
  return (async (c: any) => {
    const { sessionId, extensionId } = c.req.valid('param') as {
      sessionId: string;
      extensionId: string;
    };

    const state = await deps.router.getExtensionState(sessionId, extensionId);

    if (state === undefined) {
      return c.json({ error: 'Session or extension not found' }, 404);
    }

    return c.json(state, 200);
  }) as RouteHandler<typeof extensionStateRoute>;
}

export const extensionListRoute = createRoute({
  method: 'get',
  path: '/v1/sessions/{sessionId}/extensions',
  tags: ['Extensions'],
  summary: 'List loaded extensions',
  description:
    'Returns all extensions loaded in a specific session, keyed by extension identifier. Each entry optionally includes the display name declared by the factory.',
  request: {
    params: extensionListParamSchema,
  },
  responses: {
    200: {
      content: {
        'application/json': { schema: extensionListResponseSchema },
      },
      description: 'Map of extension identifiers to extension info',
    },
    404: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Session not found',
    },
  },
});

export function getExtensionList(
  deps: ExtensionRouteDependencies,
): RouteHandler<typeof extensionListRoute> {
  // biome-ignore lint/suspicious/noExplicitAny: RouteHandler generic causes TS2589 type instantiation depth exceeded
  return (async (c: any) => {
    const { sessionId } = c.req.valid('param') as { sessionId: string };

    const extensions = deps.router.getExtensions(sessionId);

    if (extensions === undefined) {
      return c.json({ error: 'Session not found' }, 404);
    }

    return c.json(extensions, 200);
  }) as RouteHandler<typeof extensionListRoute>;
}
