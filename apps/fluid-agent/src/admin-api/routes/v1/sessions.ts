import { createRoute, type RouteHandler } from '@hono/zod-openapi';

import type { Router } from '@/router';

import { errorResponseSchema, sessionsResponseSchema } from './schemas';

export interface SessionRouteDependencies {
  router: Router;
}

export const sessionsRoute = createRoute({
  method: 'get',
  path: '/v1/sessions',
  tags: ['Sessions'],
  summary: 'List all sessions',
  description:
    'Returns all chat sessions with their lifecycle status, runtime state, active model, token consumption, and turn/step counts.',
  responses: {
    200: {
      content: {
        'application/json': { schema: sessionsResponseSchema },
      },
      description: 'List of sessions',
    },
    500: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Internal server error',
    },
  },
});

export function getSessions(
  deps: SessionRouteDependencies,
): RouteHandler<typeof sessionsRoute> {
  return (c) => {
    const sessions = deps.router.getSessions();
    return c.json({ sessions }, 200);
  };
}
