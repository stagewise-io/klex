import type { ProviderDefinition } from '../provider-registry';
import { resolveCatalogMetadata } from './model-catalog-helpers';
import {
  createOpenAiCompatibleLanguageModel,
  discoverOpenAiCompatibleModels,
  testDiscoveryConnection,
} from './shared';

const BASE_URL = 'https://opencode.ai/zen/v1';

export const openCodeZenProviderDefinition: ProviderDefinition = {
  type: 'opencode-zen',
  usageGuidance:
    'Use for the OpenCode Zen pay-as-you-go model catalog. Use OpenCode Go for models included in that plan.',
  metadata: {
    displayName: 'OpenCode Zen',
    description: 'Models routed through the OpenCode Zen service.',
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
