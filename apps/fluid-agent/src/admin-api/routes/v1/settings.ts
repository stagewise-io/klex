import type { Context } from 'hono';

import type { ModuleLogger } from '@stagewise/logger';

import type { Config, ModelSelection } from '@/config';
import { ConfigValidationError, modelSelectionSchema } from '@/config';

export interface SettingsRouteDependencies {
  config: Config;
  logger: ModuleLogger;
}

export function getModelSelection(deps: SettingsRouteDependencies) {
  return (c: Context) => {
    return c.json(deps.config.get().modelSelection);
  };
}

export function patchModelSelection(deps: SettingsRouteDependencies) {
  return async (c: Context) => {
    let input: unknown;
    try {
      input = await c.req.json();
    } catch {
      return c.json({ error: 'Request body must be valid JSON' }, 400);
    }

    if (typeof input !== 'object' || input === null) {
      return c.json({ error: 'Request body must be a JSON object' }, 400);
    }

    const patch = input as Record<string, unknown>;
    const current = deps.config.get().modelSelection;
    const merged: ModelSelection = {
      chat:
        'chat' in patch ? (patch.chat as ModelSelection['chat']) : current.chat,
      compression:
        'compression' in patch
          ? (patch.compression as ModelSelection['compression'])
          : current.compression,
      memory:
        'memory' in patch
          ? (patch.memory as ModelSelection['memory'])
          : current.memory,
    };

    let validated: ModelSelection;
    try {
      validated = modelSelectionSchema.parse(merged);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Invalid model selection';
      return c.json({ error: message }, 400);
    }

    try {
      const config = await deps.config.updateModelSelection(validated);
      return c.json(config.modelSelection);
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        return c.json({ error: error.message }, 400);
      }
      deps.logger.error({ error }, 'Model selection update failed');
      return c.json({ error: 'Failed to update model selection' }, 500);
    }
  };
}
