import { createRoute, type RouteHandler } from '@hono/zod-openapi';

import {
  type GodMessages,
  GodMessagesError,
  serializeMessages,
} from '@/god-messages';

import {
  createGodMessageBodySchema,
  createGodMessageResponseSchema,
  errorResponseSchema,
  godMessageResetResponseSchema,
  godMessagesQuerySchema,
  godMessagesResponseSchema,
  godSessionInfoResponseSchema,
} from './schemas';

export interface GodMessagesRouteDependencies {
  godMessages: GodMessages;
}

export const createGodMessageRoute = createRoute({
  method: 'post',
  path: '/v1/god-messages',
  tags: ['God Messages'],
  summary: 'Send a god message',
  description:
    'Queues a god message in the dedicated god-message chat session. Content blocks (text, image, audio, resource_link, resource) are wrapped in <god-message> XML and presented to the model as authoritative directives.',
  request: {
    body: {
      content: {
        'application/json': { schema: createGodMessageBodySchema },
      },
      required: true,
    },
  },
  responses: {
    202: {
      content: {
        'application/json': { schema: createGodMessageResponseSchema },
      },
      description: 'God message accepted and injected into the session',
    },
    400: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Invalid request body',
    },
    409: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'God session reset is in progress',
    },
    503: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'God messages module is not running',
    },
    500: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Internal server error',
    },
  },
});

export function createGodMessage(
  deps: GodMessagesRouteDependencies,
): RouteHandler<typeof createGodMessageRoute> {
  return async (c) => {
    const { content } = c.req.valid('json');
    try {
      const result = await deps.godMessages.sendGodMessage(content);
      return c.json(result, 202);
    } catch (error) {
      if (error instanceof GodMessagesError) {
        if (error.code === 'reset-in-progress') {
          return c.json(
            { error: error.message, code: 'reset_in_progress' },
            409,
          );
        }
        if (error.code === 'not-running') {
          return c.json({ error: error.message, code: 'not_running' }, 503);
        }
      }
      throw error;
    }
  };
}

// --- God session observability ---

export const getGodSessionRoute = createRoute({
  method: 'get',
  path: '/v1/god-messages/session',
  tags: ['God Messages'],
  summary: 'Get god session state',
  description:
    "Returns the god session's current runtime state, model, usage, and metadata. Returns 404 only when no session object exists (module not started or session being created/replaced). A terminated session returns 200 with runtimeState 'terminated'.",
  responses: {
    200: {
      content: {
        'application/json': { schema: godSessionInfoResponseSchema },
      },
      description: 'God session info',
    },
    404: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'No god session exists',
    },
  },
});

export function getGodSession(
  deps: GodMessagesRouteDependencies,
): RouteHandler<typeof getGodSessionRoute> {
  return (c) => {
    const info = deps.godMessages.getSessionInfo();
    if (!info) {
      return c.json({ error: 'No god session exists', code: 'not_found' }, 404);
    }
    return c.json(info, 200);
  };
}

export const getGodMessagesRoute = createRoute({
  method: 'get',
  path: '/v1/god-messages/messages',
  tags: ['God Messages'],
  summary: 'Get god session message history',
  description:
    'Returns serialized message history with cursor-based pagination. Without a cursor, returns the most recent N messages. With a cursor, returns up to N messages older than the cursor message. Base64 data in image/audio parts is redacted.',
  request: {
    query: godMessagesQuerySchema,
  },
  responses: {
    200: {
      content: {
        'application/json': { schema: godMessagesResponseSchema },
      },
      description: 'Serialized message history with pagination cursor',
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
  },
});

export function getGodMessages(
  deps: GodMessagesRouteDependencies,
): RouteHandler<typeof getGodMessagesRoute> {
  return (c) => {
    const { limit, cursor } = c.req.valid('query');
    const allMessages = deps.godMessages.getMessages();

    let startIndex: number;
    let endIndex: number;

    if (cursor) {
      // Find the cursor message's index.
      const cursorIndex = allMessages.findIndex((m) => m.id === cursor);
      if (cursorIndex === -1) {
        // Cursor not found — return empty.
        return c.json({ messages: [], nextCursor: null, hasMore: false }, 200);
      }
      // Return up to `limit` messages before the cursor.
      endIndex = cursorIndex;
      startIndex = Math.max(0, endIndex - limit);
    } else {
      // No cursor — return the last `limit` messages (most recent).
      endIndex = allMessages.length;
      startIndex = Math.max(0, endIndex - limit);
    }

    const slice = allMessages.slice(startIndex, endIndex);
    const serialized = serializeMessages(slice);

    const hasMore = startIndex > 0;
    const nextCursor = hasMore ? (slice[0]?.id ?? null) : null;

    return c.json({ messages: serialized, nextCursor, hasMore }, 200);
  };
}

export const resetGodSessionRoute = createRoute({
  method: 'post',
  path: '/v1/god-messages/reset',
  tags: ['God Messages'],
  summary: 'Reset the god session',
  description:
    'Terminates the current god session and creates a fresh one with a new UUID and empty history. Only allowed when the session is idle or terminated (error state). Returns 409 if the session is busy (working, retrying, or success) or if a reset is already in progress.',
  responses: {
    200: {
      content: {
        'application/json': { schema: godMessageResetResponseSchema },
      },
      description: 'God session reset successfully',
    },
    404: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'No god session exists',
    },
    409: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Session is busy or a reset is already in progress',
    },
    500: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Internal server error',
    },
  },
});

export function resetGodSession(
  deps: GodMessagesRouteDependencies,
): RouteHandler<typeof resetGodSessionRoute> {
  return async (c) => {
    try {
      const result = await deps.godMessages.resetSession();
      return c.json(result, 200);
    } catch (error) {
      if (error instanceof GodMessagesError) {
        if (error.code === 'reset-in-progress') {
          return c.json(
            { error: error.message, code: 'reset_in_progress' },
            409,
          );
        }
        if (error.code === 'session-busy') {
          return c.json({ error: error.message, code: 'session_busy' }, 409);
        }
        if (error.code === 'not-running') {
          return c.json({ error: error.message, code: 'not_found' }, 404);
        }
      }

      return c.json(
        { error: 'Failed to reset god session', code: 'internal_error' },
        500,
      );
    }
  };
}
