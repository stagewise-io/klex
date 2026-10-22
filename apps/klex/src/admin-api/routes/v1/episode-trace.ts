import { createRoute, type RouteHandler, z } from '@hono/zod-openapi';

import type { EpisodeFeed } from '@/session/chat/extensions/memory';
import { parseEpisodeId } from '@/session/chat/extensions/memory/episodes/episode-feed';
import { recordEntrySchema } from '@/session/chat/extensions/memory/episodes/episode-format';

import { errorResponseSchema } from './schemas';

export const getEpisodeTraceRoute = createRoute({
  method: 'get',
  path: '/v1/episode-summaries/trace',
  tags: ['Episode summaries'],
  summary: 'Read the recorded steps of a finished episode',
  description:
    'Returns a page of archived memory records in chronological order. The default page contains the newest records; pass nextCursor to read earlier records. Archived fields may be abbreviated.',
  request: {
    query: z.object({
      episodeId: z
        .string()
        .max(128)
        .refine((id) => parseEpisodeId(id) !== null, 'Invalid episode ID'),
      cursor: z.coerce.number().int().nonnegative().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(40),
    }),
  },
  responses: {
    200: {
      description: 'Archived episode records',
      content: {
        'application/json': {
          schema: z.object({
            records: z.array(
              recordEntrySchema.extend({
                index: z.number().int().nonnegative(),
              }),
            ),
            nextCursor: z.number().int().nonnegative().nullable(),
            hasMore: z.boolean(),
          }),
        },
      },
    },
    400: {
      description: 'Invalid episode ID or pagination',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    404: {
      description: 'Episode missing or still open',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    500: {
      description: 'Episode could not be read',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    503: {
      description: 'Memory is not running',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

export function getEpisodeTrace(deps: {
  episodeFeed: EpisodeFeed;
}): RouteHandler<typeof getEpisodeTraceRoute> {
  return async (c) => {
    if (!deps.episodeFeed.isAvailable())
      return c.json(
        {
          error:
            'Episode history is not available because memory is not running',
          code: 'not_running',
        },
        503,
      );
    const { episodeId, cursor, limit } = c.req.valid('query');
    const episode = await deps.episodeFeed.read(episodeId);
    if (!episode)
      return c.json(
        {
          error: 'This episode is missing or has not finished yet',
          code: 'not_found',
        },
        404,
      );
    const end = Math.min(
      cursor ?? episode.records.length,
      episode.records.length,
    );
    const start = Math.max(0, end - limit);
    return c.json(
      {
        records: episode.records
          .slice(start, end)
          .map((record, index) => ({ ...record, index: start + index })),
        nextCursor: start > 0 ? start : null,
        hasMore: start > 0,
      },
      200,
    );
  };
}
