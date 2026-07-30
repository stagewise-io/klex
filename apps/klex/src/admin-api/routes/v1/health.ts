import { createRoute, type RouteHandler } from '@hono/zod-openapi';

import { healthResponseSchema } from './schemas';

export const healthRoute = createRoute({
  method: 'get',
  path: '/v1/health',
  tags: ['Health'],
  summary: 'Health check',
  responses: {
    200: {
      content: {
        'application/json': { schema: healthResponseSchema },
      },
      description: 'Service is healthy',
    },
  },
});

export function getHealth(): RouteHandler<typeof healthRoute> {
  return (c) => {
    return c.json({ status: 'ok', timestamp: new Date().toISOString() }, 200);
  };
}
