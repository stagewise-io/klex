import type { ProviderDefinition } from '../provider-registry';
import { resolveCatalogMetadata } from './model-catalog-helpers';
import {
  createOpenAiCompatibleLanguageModel,
  discoverOpenAiCompatibleModels,
  testDiscoveryConnection,
} from './shared';

const BASE_URL = 'https://opencode.ai/zen/go/v1';

export const openCodeGoProviderDefinition: ProviderDefinition = {
  type: 'opencode-go',
  usageGuidance:
    'Use for models included in the OpenCode Go plan. Use OpenCode Zen for the broader pay-as-you-go model catalog.',
  metadata: {
    displayName: 'OpenCode Go',
    description: 'Models included in the OpenCode Go plan.',
  },
  resolveModelMetadata: (modelId) =>
    resolveCatalogMetadata(modelId, [], modelId),
  createLanguageModel: (instance, modelId) =>
    createOpenAiCompatibleLanguageModel(instance, modelId, BASE_URL),
  discoverModels: (instance, signal) =>
    discoverOpenAiCompatibleModels(instance, BASE_URL, signal),
  testConnection: (instance, signal) =>
    testDiscoveryConnection(instance, BASE_URL, () =>
      discoverOpenAiCompatibleModels(instance, BASE_URL, signal),
    ),
};
