import { createRoute, type RouteHandler } from '@hono/zod-openapi';

import {
  InvalidSessionHistoryCursorError,
  type SessionHistory,
} from '@/session-history';

import {
  errorResponseSchema,
  sessionHistoryListQuerySchema,
  sessionHistoryListResponseSchema,
  sessionHistoryMessagesQuerySchema,
  sessionHistoryMessagesResponseSchema,
  sessionHistoryRecordSchema,
  sessionInstanceIdParamSchema,
} from './schemas';
import { serializeHistoryMessage } from './serialize-history-message';

export interface SessionsRouteDependencies {
  sessionHistory: SessionHistory;
}

const NOT_FOUND = {
  error: 'Session instance not found',
  code: 'session_not_found',
} as const;

export const listSessionHistoryRoute = createRoute({
  method: 'get',
  path: '/v1/sessions',
  tags: ['Sessions'],
  summary: 'List persisted session instances',
  description:
    'Lists persisted chat session instances (default, god, and child), newest first. Each ChatSession instance has its own `instanceId`; the default session reuses `sessionId = "default"` across replacements. Use `kind=default&live=true&limit=1` to find the current main session. A session is persisted only after its first message, so the list can be empty right after a restart.',
  request: {
    query: sessionHistoryListQuerySchema,
  },
  responses: {
    200: {
      content: {
        'application/json': { schema: sessionHistoryListResponseSchema },
      },
      description: 'Page of session instances with a pagination cursor',
    },
    400: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Invalid query parameters or cursor',
    },
    500: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Internal server error',
    },
  },
});

export function listSessionHistory(
  deps: SessionsRouteDependencies,
): RouteHandler<typeof listSessionHistoryRoute> {
  return async (c) => {
    const query = c.req.valid('query');
    try {
      const page = await deps.sessionHistory.listSessions(query);
      return c.json(page, 200);
    } catch (error) {
      if (error instanceof InvalidSessionHistoryCursorError) {
        return c.json({ error: error.message, code: 'invalid_cursor' }, 400);
      }
      throw error;
    }
  };
}

export const getSessionHistoryRoute = createRoute({
  method: 'get',
  path: '/v1/sessions/{instanceId}',
  tags: ['Sessions'],
  summary: 'Get a persisted session instance',
  description:
    'Returns metadata of one persisted session instance, including whether it is still live and how many leading messages were trimmed by the size cap.',
  request: {
    params: sessionInstanceIdParamSchema,
  },
  responses: {
    200: {
      content: {
        'application/json': { schema: sessionHistoryRecordSchema },
      },
      description: 'Session instance metadata',
    },
    404: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Unknown session instance',
    },
    500: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Internal server error',
    },
  },
});

export function getSessionHistory(
  deps: SessionsRouteDependencies,
): RouteHandler<typeof getSessionHistoryRoute> {
  return async (c) => {
    const { instanceId } = c.req.valid('param');
    const record = await deps.sessionHistory.getSession(instanceId);
    if (!record) return c.json(NOT_FOUND, 404);
    return c.json(record, 200);
  };
}

export const getSessionHistoryMessagesRoute = createRoute({
  method: 'get',
  path: '/v1/sessions/{instanceId}/messages',
  tags: ['Sessions'],
  summary: 'Get the persisted transcript of a session instance',
  description:
    'Returns a chronological page of persisted messages in AI SDK `UIMessage` shape (`tool-${name}` parts with full `input`/`output`, `data-${name}` parts with their `data`). Without a cursor, returns the newest `limit` messages. Pass `nextCursor` as `cursor` to load the previous (older) page. Inline data is redacted everywhere, including tool outputs: the payload of every `data:` URL (any encoding, also inside longer strings), image/audio/media block `data`, and resource `blob`. Provider metadata (`providerMetadata`, `callProviderMetadata`, `resultProviderMetadata`) is omitted unless `includeProviderMetadata=true`. Messages removed by the size cap are counted in `trimmedMessageCount`.',
  request: {
    params: sessionInstanceIdParamSchema,
    query: sessionHistoryMessagesQuerySchema,
  },
  responses: {
    200: {
      content: {
        'application/json': { schema: sessionHistoryMessagesResponseSchema },
      },
      description: 'Page of serialized messages with a pagination cursor',
    },
    400: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Invalid query parameters',
    },
    404: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Unknown session instance',
    },
    500: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Internal server error',
    },
  },
});

export function getSessionHistoryMessages(
  deps: SessionsRouteDependencies,
): RouteHandler<typeof getSessionHistoryMessagesRoute> {
  return async (c) => {
    const { instanceId } = c.req.valid('param');
    const { limit, cursor, includeProviderMetadata } = c.req.valid('query');
    const page = await deps.sessionHistory.getMessages(instanceId, {
      limit,
      ...(cursor === undefined ? {} : { beforeSeq: cursor }),
    });
    if (!page) return c.json(NOT_FOUND, 404);

    const options = {
      includeProviderMetadata: includeProviderMetadata ?? false,
    };
    const messages = page.messages.map((entry) => ({
      ...serializeHistoryMessage(entry.message, options),
      seq: entry.seq,
      persistedAt: entry.persistedAt,
    }));

    return c.json(
      {
        messages,
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
        trimmedMessageCount: page.trimmedMessageCount,
      },
      200,
    );
  };
}
