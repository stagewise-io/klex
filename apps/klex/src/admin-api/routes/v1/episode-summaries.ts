import { createRoute, type RouteHandler } from '@hono/zod-openapi';

import type { EpisodeSummaryLog } from '@/session/chat/extensions/episode-summary/summary-log';

import {
  episodeSummaryListQuerySchema,
  episodeSummaryListResponseSchema,
  errorResponseSchema,
} from './schemas';

export interface EpisodeSummariesRouteDependencies {
  episodeSummaryLog: EpisodeSummaryLog;
}

const NOT_RUNNING = {
  error:
    'Episode summaries are not available because the episode-summary extension is not running',
  code: 'not_running',
} as const;

export const listEpisodeSummariesRoute = createRoute({
  method: 'get',
  path: '/v1/episode-summaries',
  tags: ['Episode summaries'],
  summary: 'List episode summaries',
  description:
    'Lists short titles of what the agent did, one per finished memory episode, newest first. Only episodes finished after the feature was first enabled are titled; trivial episodes are omitted.',
  request: {
    query: episodeSummaryListQuerySchema,
  },
  responses: {
    200: {
      content: {
        'application/json': { schema: episodeSummaryListResponseSchema },
      },
      description: 'Episode summaries, sorted by start time, newest first',
    },
    400: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Invalid query parameters',
    },
    500: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Internal server error',
    },
    503: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Episode-summary extension is not running',
    },
  },
});

export function listEpisodeSummaries(
  deps: EpisodeSummariesRouteDependencies,
): RouteHandler<typeof listEpisodeSummariesRoute> {
  return async (c) => {
    if (!deps.episodeSummaryLog.isAvailable()) return c.json(NOT_RUNNING, 503);
    const { limit, cursor } = c.req.valid('query');
    const page = await deps.episodeSummaryLog.list({
      limit,
      ...(cursor ? { cursor } : {}),
    });
    return c.json(
      {
        summaries: page.items,
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      },
      200,
    );
  };
}
