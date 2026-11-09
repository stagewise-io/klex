import { createGateway } from 'ai';

import type {
  ProviderDefinition,
  ProviderInstance,
} from '../provider-registry';
import { resolveCatalogMetadata } from './model-catalog-helpers';
import { withPromptCaching } from './prompt-caching';
import {
  available,
  customHeaders,
  requiredSetting,
  sanitizedError,
  setting,
  unavailable,
} from './shared';

const BASE_URL = 'https://ai-gateway.vercel.sh/v4/ai';
const JEV_MODEL_ID = 'typesafe-ai/jev';

function createProvider(instance: ProviderInstance, signal?: AbortSignal) {
  return createGateway({
    apiKey: requiredSetting(instance, 'apiKey'),
    baseURL: setting(instance, 'baseUrl'),
    teamIdOrSlug: setting(instance, 'teamIdOrSlug'),
    headers: customHeaders(instance),
    // SDK metadata operations do not accept an abort signal themselves.
    fetch: (url, init) =>
      fetch(url, {
        ...init,
        ...(signal && {
          signal: init?.signal
            ? AbortSignal.any([signal, init.signal])
            : signal,
        }),
      }),
  });
}

export const vercelAiGatewayProviderDefinition: ProviderDefinition = {
  type: 'vercel-ai-gateway',
  usageGuidance:
    'Route language generation and instinct evaluation through Vercel AI Gateway. Select the evaluation API for typesafe-ai/jev; Jev cannot generate chat messages. The base URL uses the native AI SDK protocol (/v4/ai), not the OpenAI-compatible /v1 endpoint. Connectivity checks query credits without paid inference.',
  metadata: {
    displayName: 'Vercel AI Gateway',
    description: 'Native AI SDK model routing, including Jev evaluation.',
    documentationUrl:
      'https://ai-sdk.dev/providers/ai-sdk-providers/ai-gateway',
  },
  createLanguageModel: (instance, modelId) => {
    if (modelId === JEV_MODEL_ID || modelId === 'liquid/d1')
      throw new Error('Evaluation-only model cannot generate language');
    return withPromptCaching(
      createProvider(instance).languageModel(modelId),
      'gateway',
    );
  },
  createEvaluationModel: (instance, modelId) =>
    createProvider(instance).evaluationModel(modelId),
  resolveModelMetadata: (modelId) =>
    modelId === JEV_MODEL_ID || modelId === 'liquid/d1'
      ? {
          kind: 'evaluation',
          ...(modelId === JEV_MODEL_ID && { displayName: 'Jev' }),
          provenance: [{ source: 'provider-exact' }],
        }
      : resolveCatalogMetadata(modelId, [], modelId),
  discoverModels: async (instance, signal) => {
    try {
      const { models } = await createProvider(
        instance,
        signal,
      ).getAvailableModels();
      return available(
        models.flatMap((model) => {
          const kind =
            model.id === JEV_MODEL_ID || model.id === 'liquid/d1'
              ? 'evaluation'
              : (model.modelType ?? 'language');
          if (kind !== 'language' && kind !== 'evaluation') return [];
          return [
            {
              modelId: model.id,
              displayName: model.name,
              kind,
              provenance: [{ source: 'discovered' as const }],
            },
          ];
        }),
      );
    } catch (error) {
      return unavailable('discovery_failed', sanitizedError(error));
    }
  },
  testConnection: async (instance, signal) => {
    const startedAt = performance.now();
    try {
      await createProvider(instance, signal).getCredits();
      return available({
        latencyMs: performance.now() - startedAt,
        target: new URL(setting(instance, 'baseUrl') ?? BASE_URL).origin,
      });
    } catch (error) {
      return unavailable('connectivity_failed', sanitizedError(error));
    }
  },
};
