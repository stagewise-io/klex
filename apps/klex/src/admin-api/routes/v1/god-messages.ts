import { createRoute, type RouteHandler } from '@hono/zod-openapi';

import type { GodMessages } from '@/god-messages';

import {
  createGodMessageBodySchema,
  createGodMessageResponseSchema,
  errorResponseSchema,
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
    'Injects a high-priority god message into the dedicated god-message chat session. The message is processed immediately by the session loop. Content blocks (text, image, audio, resource_link, resource) are wrapped in <god-message> XML and presented to the model as authoritative directives.',
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
    const result = await deps.godMessages.sendGodMessage(content);
    return c.json(result, 202);
  };
}
