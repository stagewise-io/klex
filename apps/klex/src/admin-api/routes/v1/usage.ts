import { createRoute, type RouteHandler } from '@hono/zod-openapi';

import type { ModuleLogger } from '@stagewise/logger';

import type { ModelCallLogger } from '@/model-call-logger';

import {
  errorResponseSchema,
  usageQuerySchema,
  usageResponseSchema,
} from './schemas';

export const getUsageRoute = createRoute({
  method: 'get',
  path: '/v1/usage',
  tags: ['Usage'],
  summary: 'Query model call usage data',
  description:
    'Returns aggregated or per-event model call usage data, optionally filtered by time range and grouped by model, provider, or endpoint.',
  request: {
    query: usageQuerySchema,
  },
  responses: {
    200: {
      content: {
        'application/json': { schema: usageResponseSchema },
      },
      description: 'Usage data points',
    },
    400: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description: 'Invalid query parameters',
    },
    500: {
      content: {
        'application/json': {
          schema: errorResponseSchema,
        },
      },
      description: 'Internal server error',
    },
  },
});

export interface UsageRouteDependencies {
  modelCallLogger: ModelCallLogger;
  logger: ModuleLogger;
}

export function getUsage(
  deps: UsageRouteDependencies,
): RouteHandler<typeof getUsageRoute> {
  return async (c) => {
    const { splitBy, from, to, granularity, limit } = c.req.valid('query');

    try {
      const dataPoints = await deps.modelCallLogger.queryUsage({
        splitBy,
        from: from ?? null,
        to: to ?? null,
        granularity,
        limit,
      });

      return c.json({ dataPoints }, 200);
    } catch (error) {
      deps.logger.error({ error }, 'Usage query failed');
      return c.json({ error: 'Internal server error' }, 500);
    }
  };
}
