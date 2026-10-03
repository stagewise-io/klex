import { createTypeSafeAi } from '@ai-sdk/typesafe-ai';
import { experimental_evaluate as evaluate } from 'ai';

import type {
  ProviderDefinition,
  ProviderInstance,
} from '../provider-registry';
import {
  available,
  customHeaders,
  requiredSetting,
  setting,
  unavailable,
} from './shared';

const MODEL_ID = 'jev-latest';
function createEvaluationModel(instance: ProviderInstance, modelId: string) {
  return createTypeSafeAi({
    apiKey: requiredSetting(instance, 'apiKey'),
    baseURL: setting(instance, 'baseUrl'),
    headers: customHeaders(instance),
  }).evaluationModel(modelId);
}

export const typeSafeAiProviderDefinition: ProviderDefinition = {
  type: 'typesafe-ai',
  usageGuidance:
    'Use the native TypeSafe evaluation API for instinct classification. It cannot generate chat messages; use a language provider for chat. Testing connectivity performs a paid synthetic evaluation.',
  metadata: {
    displayName: 'TypeSafe AI',
    description:
      'Native boolean and choice evaluation, without a language-model API.',
    documentationUrl: 'https://typesafe.ai',
  },
  createEvaluationModel,
  resolveModelMetadata: (modelId) => ({
    kind: 'evaluation',
    ...(modelId === MODEL_ID && {
      displayName: 'Jev (latest)',
      provenance: [{ source: 'provider-exact' }],
    }),
  }),
  discoverModels: async () =>
    available([
      {
        modelId: MODEL_ID,
        kind: 'evaluation',
        displayName: 'Jev (latest)',
        provenance: [{ source: 'provider-exact' }],
      },
    ]),
  testConnection: async (instance, signal) => {
    const started = performance.now();
    try {
      await evaluate({
        model: createEvaluationModel(instance, MODEL_ID),
        state: 'Synthetic connection test: the flag is true.',
        questions: {
          flag: { type: 'boolean', instructions: 'Is the flag true?' },
        },
        abortSignal: signal,
        maxRetries: 0,
      });
      return available({ latencyMs: performance.now() - started });
    } catch {
      return unavailable(
        'connectivity_failed',
        'TypeSafe evaluation failed; check credentials, endpoint, and model availability.',
      );
    }
  },
};
