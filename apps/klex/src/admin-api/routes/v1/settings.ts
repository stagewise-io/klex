import { createRoute, type RouteHandler } from '@hono/zod-openapi';

import type { ModuleLogger } from '@stagewise/logger';

import type { Config, ModelSelection } from '@/config';
import { ConfigValidationError } from '@/config';

import {
  errorResponseSchema,
  modelSelectionPatchSchema,
  modelSelectionSchema,
} from './schemas';

export interface SettingsRouteDependencies {
  config: Config;
  logger: ModuleLogger;
}

export const getModelSelectionRoute = createRoute({
  method: 'get',
  path: '/v1/settings/model-selection',
  tags: ['Settings'],
  summary: 'Get model selection',
  description:
    'Returns the current model selection for chat, compaction, and memory purposes.',
  responses: {
    200: {
      content: {
        'application/json': { schema: modelSelectionSchema },
      },
      description: 'Current model selection',
    },
    500: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Internal server error',
    },
  },
});

export function getModelSelection(
  deps: SettingsRouteDependencies,
): RouteHandler<typeof getModelSelectionRoute> {
  return (c) => {
    return c.json(deps.config.get().modelSelection, 200);
  };
}

export const patchModelSelectionRoute = createRoute({
  method: 'patch',
  path: '/v1/settings/model-selection',
  tags: ['Settings'],
  summary: 'Update model selection',
  description:
    'Partially updates the model selection. Only provided fields are updated; omitted fields preserve their current values.',
  request: {
    body: {
      content: {
        'application/json': { schema: modelSelectionPatchSchema },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        'application/json': { schema: modelSelectionSchema },
      },
      description: 'Updated model selection',
    },
    400: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Invalid model selection or validation error',
    },
    500: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Internal server error',
    },
  },
});

export function patchModelSelection(
  deps: SettingsRouteDependencies,
): RouteHandler<typeof patchModelSelectionRoute> {
  return async (c) => {
    const patch = c.req.valid('json');
    const current = deps.config.get().modelSelection;
    const merged = {
      chat: patch.chat ?? current.chat,
      compaction: patch.compaction ?? current.compaction,
      memory: patch.memory ?? current.memory,
    } as ModelSelection;

    try {
      const config = await deps.config.updateModelSelection(merged);
      return c.json(config.modelSelection, 200);
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        return c.json({ error: error.message }, 400);
      }
      deps.logger.error({ error }, 'Model selection update failed');
      return c.json({ error: 'Failed to update model selection' }, 500);
    }
  };
}
