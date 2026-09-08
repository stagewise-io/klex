import type { ProviderDefinition } from '../provider-registry';
import { resolveCatalogMetadata } from './model-catalog-helpers';
import {
  createOpenAiCompatibleLanguageModel,
  discoverOpenAiCompatibleModels,
  testDiscoveryConnection,
} from './shared';

const BASE_URL = 'https://api.x.ai/v1';

export const xaiProviderDefinition: ProviderDefinition = {
  type: 'xai',
  usageGuidance:
    'Use for xAI models through the official OpenAI-compatible API. Use Chat Completions for a custom proxy endpoint.',
  metadata: {
    displayName: 'xAI',
    description: 'Grok models served through the official xAI API.',
  },
  resolveModelMetadata: (modelId) =>
    resolveCatalogMetadata(modelId, [], undefined, [
      {
        prefixes: ['grok-'],
        metadata: {
          kind: 'language',
          capabilities: { input: { image: {} } },
        },
        documentationUrl: 'https://docs.x.ai/docs/models',
      },
    ]),
  createLanguageModel: (instance, modelId) =>
    createOpenAiCompatibleLanguageModel(instance, modelId, BASE_URL),
  discoverModels: (instance, signal) =>
    discoverOpenAiCompatibleModels(instance, BASE_URL, signal),
  testConnection: (instance, signal) =>
    testDiscoveryConnection(instance, BASE_URL, () =>
      discoverOpenAiCompatibleModels(instance, BASE_URL, signal),
    ),
};
