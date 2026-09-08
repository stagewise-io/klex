import type { ProviderDefinition } from '../provider-registry';
import { resolveCatalogMetadata } from './model-catalog-helpers';
import {
  createOpenAiCompatibleLanguageModel,
  discoverOpenAiCompatibleModels,
  testDiscoveryConnection,
} from './shared';

const BASE_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';

export const alibabaQwenProviderDefinition: ProviderDefinition = {
  type: 'alibaba-qwen',
  usageGuidance:
    'Use for Alibaba Qwen models through the international DashScope OpenAI-compatible API endpoint.',
  metadata: {
    displayName: 'Alibaba Qwen',
    description: 'Qwen models served through Alibaba DashScope.',
  },
  resolveModelMetadata: (modelId) =>
    resolveCatalogMetadata(modelId, [], modelId, [
      {
        prefixes: ['qwen'],
        includesAny: ['omni'],
        metadata: {
          kind: 'language',
          capabilities: { input: { image: {}, audio: {} } },
        },
      },
      {
        prefixes: ['qwen'],
        includesAny: ['vision', '-vl'],
        metadata: {
          kind: 'language',
          capabilities: { input: { image: {} } },
        },
      },
      {
        prefixes: ['qwen'],
        includesAny: ['audio'],
        metadata: {
          kind: 'language',
          capabilities: { input: { audio: {} } },
        },
      },
      {
        prefixes: ['qwen'],
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
