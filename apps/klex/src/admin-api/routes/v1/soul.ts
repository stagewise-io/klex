import { createRoute, type RouteHandler, z } from '@hono/zod-openapi';

import { type Soul, SoulError } from '@/session/chat/extensions/soul';

import { errorResponseSchema } from './schemas';

export interface SoulRouteDependencies {
  soul: Soul;
  soulAbortSignal?: AbortSignal;
}

const soulSchema = z.string().min(1).max(10_000);
const bodySchema = z.object({
  instructions: z.string().trim().min(1).max(10_000),
});
const request = {
  body: {
    content: { 'application/json': { schema: bodySchema } },
    required: true,
  },
};
const failureResponses = {
  400: {
    content: { 'application/json': { schema: errorResponseSchema } },
    description: 'Invalid instructions',
  },
  404: {
    content: { 'application/json': { schema: errorResponseSchema } },
    description: 'PATCH requires an existing soul',
  },
  409: {
    content: { 'application/json': { schema: errorResponseSchema } },
    description:
      'Another operation is in progress or the soul changed during generation',
  },
  502: {
    content: { 'application/json': { schema: errorResponseSchema } },
    description:
      'Soul generation failed after three attempts; saved soul is unchanged',
  },
  503: {
    content: { 'application/json': { schema: errorResponseSchema } },
    description: 'No chat model configured or request cancelled',
  },
  500: {
    content: { 'application/json': { schema: errorResponseSchema } },
    description: 'Failed to read or save the soul',
  },
};

export const getSoulRoute = createRoute({
  method: 'get',
  path: '/v1/soul',
  tags: ['Soul'],
  summary: 'Read the soul',
  responses: {
    200: {
      content: { 'application/json': { schema: z.string().nullable() } },
      description: 'The soul document, or null when none exists',
    },
    500: failureResponses[500],
  },
});

export const createSoulRoute = createRoute({
  method: 'post',
  path: '/v1/soul',
  tags: ['Soul'],
  summary: 'Create or re-create a soul from administrator instructions',
  description:
    'Uses a one-shot chat model call with up to three attempts in configured model order, each bounded to 60 seconds. Does not start a god session. Always generates from scratch without the old soul in model input, replacing any saved soul only after generation succeeds.',
  request,
  responses: {
    201: {
      content: { 'application/json': { schema: soulSchema } },
      description: 'The newly generated and saved soul document',
    },
    ...failureResponses,
  },
});

export const patchSoulRoute = createRoute({
  method: 'patch',
  path: '/v1/soul',
  tags: ['Soul'],
  summary: 'Update or optimize the existing soul',
  description:
    'Includes the existing soul and requested changes in a one-shot chat model call. Empty, whitespace-only, or omitted instructions optimize the existing soul according to the current prompt best practices. Requires an existing soul. Uses up to three attempts in configured model order, each bounded to 60 seconds. Saves only a complete successful result.',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            instructions: z.string().trim().max(10_000).default(''),
          }),
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: soulSchema } },
      description: 'The updated and saved soul document',
    },
    ...failureResponses,
  },
});

export function getSoul(
  deps: SoulRouteDependencies,
): RouteHandler<typeof getSoulRoute> {
  return (c) => c.json(deps.soul.get(), 200);
}

function statusFor(error: SoulError): 400 | 404 | 409 | 502 | 503 {
  switch (error.code) {
    case 'invalid_instructions':
      return 400;
    case 'soul_not_found':
      return 404;
    case 'operation_in_progress':
    case 'soul_changed':
      return 409;
    case 'generation_failed':
      return 502;
    case 'no_chat_models':
    case 'request_cancelled':
      return 503;
  }
}

export function createSoul(
  deps: SoulRouteDependencies,
): RouteHandler<typeof createSoulRoute> {
  return async (c) => {
    try {
      const soul = await deps.soul.create(
        c.req.valid('json').instructions,
        deps.soulAbortSignal
          ? AbortSignal.any([c.req.raw.signal, deps.soulAbortSignal])
          : c.req.raw.signal,
      );
      return c.json(soul, 201);
    } catch (error) {
      if (error instanceof SoulError)
        return c.json(
          { error: error.message, code: error.code },
          statusFor(error),
        );
      throw error;
    }
  };
}

export function patchSoul(
  deps: SoulRouteDependencies,
): RouteHandler<typeof patchSoulRoute> {
  return async (c) => {
    try {
      const soul = await deps.soul.update(
        c.req.valid('json').instructions,
        deps.soulAbortSignal
          ? AbortSignal.any([c.req.raw.signal, deps.soulAbortSignal])
          : c.req.raw.signal,
      );
      return c.json(soul, 200);
    } catch (error) {
      if (error instanceof SoulError)
        return c.json(
          { error: error.message, code: error.code },
          statusFor(error),
        );
      throw error;
    }
  };
}
