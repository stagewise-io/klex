import { createRoute, type RouteHandler } from '@hono/zod-openapi';

import type { ModuleLogger } from '@stagewise/logger';

import {
  type Config,
  ConfigValidationError,
  getDefaultTelemetryLevel,
  type KlexConfig,
  type ModelSelection,
  modelIdFromEntry,
  type ProviderConfig,
  type TelemetryLevel,
} from '@/config';

import {
  agentIdentityPatchSchema,
  agentIdentityResponseSchema,
  errorResponseSchema,
  modelSelectionPatchResponseSchema,
  modelSelectionPatchSchema,
  modelSelectionSchema,
  telemetrySettingsPatchSchema,
  telemetrySettingsSchema,
} from './schemas';

export interface SettingsRouteDependencies {
  config: Config;
  logger: ModuleLogger;
}

export const getAgentIdentityRoute = createRoute({
  method: 'get',
  path: '/v1/settings/agent',
  tags: ['Settings'],
  summary: 'Get agent identity',
  description: "Returns the agent's official display name.",
  responses: {
    200: {
      content: {
        'application/json': { schema: agentIdentityResponseSchema },
      },
      description: 'Agent identity',
    },
  },
});

export function getAgentIdentity(
  deps: SettingsRouteDependencies,
): RouteHandler<typeof getAgentIdentityRoute> {
  return (c) => c.json({ officialName: deps.config.get().officialName }, 200);
}

export const patchAgentIdentityRoute = createRoute({
  method: 'patch',
  path: '/v1/settings/agent',
  tags: ['Settings'],
  summary: 'Update agent identity',
  description: "Updates the agent's official display name.",
  request: {
    body: {
      content: {
        'application/json': { schema: agentIdentityPatchSchema },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        'application/json': { schema: agentIdentityResponseSchema },
      },
      description: 'Updated agent identity',
    },
    400: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Invalid official name',
    },
    500: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Internal server error',
    },
  },
});

export function patchAgentIdentity(
  deps: SettingsRouteDependencies,
): RouteHandler<typeof patchAgentIdentityRoute> {
  return async (c) => {
    const { officialName } = c.req.valid('json');

    try {
      const config = await deps.config.mutate((current) => ({
        ...current,
        officialName,
      }));
      return c.json({ officialName: config.officialName }, 200);
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        return c.json({ error: error.message, code: 'invalid_request' }, 400);
      }
      deps.logger.error({ error }, 'Agent identity update failed');
      return c.json(
        { error: 'Failed to update agent identity', code: 'internal_error' },
        500,
      );
    }
  };
}

export const getModelSelectionRoute = createRoute({
  method: 'get',
  path: '/v1/settings/model-selection',
  tags: ['Settings'],
  summary: 'Get model selection',
  description:
    'Returns the current model selection for chat, compaction, memory, image-vision, audio-listening, and voice purposes.',
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
    'Partially updates the model selection. Only provided fields are updated; omitted fields preserve their current values. Each model ID is validated against configured providers and endpoints — unknown providers or endpoints are rejected with 400. Model IDs that reference a valid provider/endpoint but are not declared in knownModels are accepted with a warning.',
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
        'application/json': { schema: modelSelectionPatchResponseSchema },
      },
      description: 'Updated model selection with optional warnings',
    },
    400: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description:
        'Invalid model selection, unknown provider, or unknown endpoint',
    },
    500: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Internal server error',
    },
  },
});

interface ModelSelectionWarning {
  modelId: string;
  message: string;
}

/**
 * Splits a model ID into its components.
 * Format: `providerId:modelId` (preset) or `providerId:endpointId:modelId` (manual).
 */
function parseModelId(modelId: string): {
  providerId: string;
  endpointId: string | undefined;
  localModelId: string;
} {
  const firstColon = modelId.indexOf(':');
  const providerId = modelId.slice(0, firstColon);
  const rest = modelId.slice(firstColon + 1);
  const secondColon = rest.indexOf(':');
  if (secondColon === -1) {
    return { providerId, endpointId: undefined, localModelId: rest };
  }
  return {
    providerId,
    endpointId: rest.slice(0, secondColon),
    localModelId: rest.slice(secondColon + 1),
  };
}

/**
 * Checks whether a model ID references a known model in the provider's
 * knownModels. For preset providers, checks `provider.knownModels`. For
 * manual providers, checks the endpoint's `knownModels`.
 */
function isKnownModel(
  provider: ProviderConfig,
  endpointId: string | undefined,
  localModelId: string,
): boolean {
  if ('preset' in provider) {
    return provider.knownModels?.[localModelId] !== undefined;
  }
  if (!endpointId) return false;
  return (
    provider.endpoints[endpointId]?.knownModels?.[localModelId] !== undefined
  );
}

/**
 * Validates that all model IDs in the merged selection reference known
 * providers and endpoints. Collects warnings for model IDs that are not
 * declared in knownModels.
 *
 * @returns Array of warnings (empty if all models are known).
 * @throws ConfigValidationError if a model ID references an unknown
 *   provider or endpoint.
 */
function validateAndCollectWarnings(
  selection: ModelSelection,
  config: KlexConfig,
): ModelSelectionWarning[] {
  const warnings: ModelSelectionWarning[] = [];

  const selections = [
    ['chat', selection.chat],
    ['compaction', selection.compaction],
    ['memory', selection.memory],
    ['imageVision', selection.imageVision],
    ['audioListening', selection.audioListening],
    ['voice.sts', selection.voice.sts],
    ['voice.tts', selection.voice.tts],
    ['voice.stt', selection.voice.stt],
  ] as const;

  for (const [purpose, entries] of selections) {
    for (const entry of entries) {
      const modelId = modelIdFromEntry(entry);
      const { providerId, endpointId, localModelId } = parseModelId(modelId);
      const provider = config.providers[providerId];

      if (!provider) {
        throw new ConfigValidationError(
          `Model selection '${purpose}' references unknown provider '${providerId}'`,
          { code: 'referential_integrity' },
        );
      }

      if ('preset' in provider) {
        if (endpointId !== undefined) {
          throw new ConfigValidationError(
            `Model selection '${purpose}' uses provider '${providerId}' (preset) with an endpoint ID; preset providers do not have endpoints`,
            { code: 'referential_integrity' },
          );
        }
      } else {
        if (endpointId === undefined) {
          throw new ConfigValidationError(
            `Model selection '${purpose}' references provider '${providerId}' without an endpoint ID; use '${providerId}:endpointId:modelId' format`,
            { code: 'referential_integrity' },
          );
        }
        if (!provider.endpoints[endpointId]) {
          throw new ConfigValidationError(
            `Model selection '${purpose}' references unknown endpoint '${providerId}:${endpointId}'`,
            { code: 'referential_integrity' },
          );
        }
      }

      if (!isKnownModel(provider, endpointId, localModelId)) {
        warnings.push({
          modelId,
          message: `Model '${modelId}' is not declared in knownModels for provider '${providerId}'${endpointId ? `, endpoint '${endpointId}'` : ''}`,
        });
      }
    }
  }

  return warnings;
}

export function patchModelSelection(
  deps: SettingsRouteDependencies,
): RouteHandler<typeof patchModelSelectionRoute> {
  return async (c) => {
    const patch = c.req.valid('json');

    let warnings: ModelSelectionWarning[] = [];
    try {
      const config = await deps.config.mutate((current) => {
        const merged = {
          chat: patch.chat ?? current.modelSelection.chat,
          compaction: patch.compaction ?? current.modelSelection.compaction,
          memory: patch.memory ?? current.modelSelection.memory,
          imageVision: patch.imageVision ?? current.modelSelection.imageVision,
          audioListening:
            patch.audioListening ?? current.modelSelection.audioListening,
          voice: patch.voice ?? current.modelSelection.voice,
        } as ModelSelection;

        // Validate only the patched fields — preserved fields are already in
        // the config and may reference providers/endpoints that were removed.
        const patchSelection = {
          chat: patch.chat ?? [],
          compaction: patch.compaction ?? [],
          memory: patch.memory ?? [],
          imageVision: patch.imageVision ?? [],
          audioListening: patch.audioListening ?? [],
          voice: patch.voice ?? { sts: [], tts: [], stt: [] },
        } as ModelSelection;
        warnings = validateAndCollectWarnings(patchSelection, current);

        return { ...current, modelSelection: merged };
      });
      return c.json({ ...config.modelSelection, warnings }, 200);
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        return c.json({ error: error.message, code: 'invalid_request' }, 400);
      }
      deps.logger.error({ error }, 'Model selection update failed');
      return c.json(
        { error: 'Failed to update model selection', code: 'internal_error' },
        500,
      );
    }
  };
}

// --- Telemetry settings ---

export const getTelemetryRoute = createRoute({
  method: 'get',
  path: '/v1/settings/telemetry',
  tags: ['Settings'],
  summary: 'Get telemetry settings',
  description:
    'Returns the current telemetry level. When not explicitly set in config, the environment-aware default is returned.',
  responses: {
    200: {
      content: {
        'application/json': { schema: telemetrySettingsSchema },
      },
      description: 'Current telemetry settings',
    },
    500: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Internal server error',
    },
  },
});

export function getTelemetry(
  deps: SettingsRouteDependencies,
): RouteHandler<typeof getTelemetryRoute> {
  return (c) => {
    const level =
      deps.config.get().telemetry?.level ?? getDefaultTelemetryLevel();
    return c.json({ level }, 200);
  };
}

export const patchTelemetryRoute = createRoute({
  method: 'patch',
  path: '/v1/settings/telemetry',
  tags: ['Settings'],
  summary: 'Update telemetry settings',
  description:
    'Updates the telemetry level. The change is persisted to config.json and applied at runtime through the telemetry manager.',
  request: {
    body: {
      content: {
        'application/json': { schema: telemetrySettingsPatchSchema },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        'application/json': { schema: telemetrySettingsSchema },
      },
      description: 'Updated telemetry settings',
    },
    400: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Invalid telemetry level',
    },
    500: {
      content: {
        'application/json': { schema: errorResponseSchema },
      },
      description: 'Internal server error',
    },
  },
});

export function patchTelemetry(
  deps: SettingsRouteDependencies,
): RouteHandler<typeof patchTelemetryRoute> {
  return async (c) => {
    const patch = c.req.valid('json');

    try {
      const config = await deps.config.mutate((current) => {
        const level: TelemetryLevel =
          patch.level ?? current.telemetry?.level ?? getDefaultTelemetryLevel();
        return {
          ...current,
          telemetry: { level },
        };
      });
      const level = config.telemetry?.level ?? getDefaultTelemetryLevel();
      return c.json({ level }, 200);
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        return c.json({ error: error.message, code: 'invalid_request' }, 400);
      }
      deps.logger.error({ error }, 'Telemetry update failed');
      return c.json(
        {
          error: 'Failed to update telemetry settings',
          code: 'internal_error',
        },
        500,
      );
    }
  };
}
