import type { ProviderDefinition } from '../provider-registry';
import { exactModel, resolveCatalogMetadata } from './model-catalog-helpers';
import {
  createOpenAiCompatibleLanguageModel,
  discoverOpenAiCompatibleModels,
  testDiscoveryConnection,
} from './shared';

const BASE_URL = 'https://api.moonshot.ai/v1';
const MODEL_DOCS = 'https://platform.kimi.ai/docs/models';
const IMAGE_CAPABILITY = {
  mediaTypes: [
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/bmp',
    'image/heic',
    'image/heif',
  ],
};
const MODEL_CATALOG = (
  [
    ['kimi-k3', 'Kimi K3', 1_000_000],
    ['kimi-k2.7-code', 'Kimi K2.7 Code', 262_144],
    ['kimi-k2.7-code-highspeed', 'Kimi K2.7 Code Highspeed', 262_144],
    ['kimi-k2.6', 'Kimi K2.6', 262_144],
  ] as const
).map(([modelId, displayName, contextSize]) =>
  exactModel(
    modelId,
    {
      kind: 'language',
      displayName,
      contextSize,
      capabilities: { input: { image: IMAGE_CAPABILITY } },
    },
    MODEL_DOCS,
  ),
);

export const moonshotProviderDefinition: ProviderDefinition = {
  type: 'moonshot',
  usageGuidance:
    'Use for Moonshot AI models through its OpenAI-compatible API. Use Chat Completions for an unrelated custom endpoint.',
  metadata: {
    displayName: 'Moonshot AI',
    description: 'Moonshot AI models served through its public API.',
  },
  resolveModelMetadata: (modelId) =>
    resolveCatalogMetadata(modelId, MODEL_CATALOG, undefined, [
      {
        prefixes: ['kimi-'],
        metadata: {
          kind: 'language',
          capabilities: { input: { image: IMAGE_CAPABILITY } },
        },
        documentationUrl: MODEL_DOCS,
      },
      {
        prefixes: ['moonshot-'],
        metadata: { kind: 'language', capabilities: { input: {} } },
        documentationUrl: MODEL_DOCS,
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
