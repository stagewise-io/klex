import { createRoute, type RouteHandler } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';

import {
  modelValidationInputSchema,
  modelValidationResultSchema,
  type ProviderRegistry,
} from '@/provider-registry';

import { errorResponseSchema } from './schemas';

export const validateModelRoute = createRoute({
  method: 'post',
  path: '/v1/models/test',
  tags: ['Providers'],
  summary: 'Test a candidate model without saving configuration',
  description:
    'Runs a small, potentially billable language-generation request with the exact model ID and provider options. Supply an existing provider ID or complete draft provider settings. HTTP 200 means the check ran; only status=valid confirms success within the returned scope. Unsupported purposes are never reported as valid.',
  middleware: [
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (c) =>
        c.json(
          {
            error: 'Model validation request is too large',
            code: 'body_too_large',
          },
          413,
        ),
    }),
  ],
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: modelValidationInputSchema } },
    },
  },
  responses: {
    200: {
      description: 'Model validation result',
      content: { 'application/json': { schema: modelValidationResultSchema } },
    },
    400: {
      description: 'Invalid request',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    413: {
      description: 'Request exceeds 64 KiB',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

export function validateModel(deps: {
  providerRegistry: Pick<ProviderRegistry, 'validateModel'>;
}): RouteHandler<typeof validateModelRoute> {
  return async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const result = await deps.providerRegistry.validateModel(
      c.req.valid('json'),
      c.req.raw.signal,
    );
    return c.json(result, 200);
  };
}
