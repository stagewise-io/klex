import type { ProviderDefinition } from '../provider-registry';
import { resolveCatalogMetadata } from './model-catalog-helpers';
import {
  createOpenAiCompatibleLanguageModel,
  discoverOpenAiCompatibleModels,
  testDiscoveryConnection,
} from './shared';

const BASE_URL = 'https://api.xiaomimimo.com/v1';

export const xiaomiMimoProviderDefinition: ProviderDefinition = {
  type: 'xiaomi-mimo',
  usageGuidance:
    'Use for Xiaomi MiMo models through the official OpenAI-compatible API. Use Chat Completions for custom gateways.',
  metadata: {
    displayName: 'Xiaomi MiMo',
    description: 'MiMo models served through the Xiaomi public API.',
  },
  resolveModelMetadata: (modelId) =>
    resolveCatalogMetadata(modelId, [], undefined, [
      {
        prefixes: ['mimo-'],
        includesAny: ['vision', '-vl'],
        metadata: {
          kind: 'language',
          capabilities: { input: { image: {} } },
        },
      },
      {
        prefixes: ['mimo-'],
        metadata: { kind: 'language', capabilities: { input: {} } },
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
