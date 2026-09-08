import type { ProviderDefinition } from '../provider-registry';
import { exactModel, resolveCatalogMetadata } from './model-catalog-helpers';
import {
  createOpenAiCompatibleLanguageModel,
  discoverOpenAiCompatibleModels,
  testDiscoveryConnection,
} from './shared';

const BASE_URL = 'https://api.deepseek.com/v1';
const PRICING_DOCS = 'https://api-docs.deepseek.com/quick_start/pricing/';
const MODEL_CATALOG = [
  exactModel(
    'deepseek-v4-flash',
    {
      kind: 'language',
      displayName: 'DeepSeek-V4-Flash',
      contextSize: 1_000_000,
    },
    PRICING_DOCS,
  ),
  exactModel(
    'deepseek-v4-pro',
    {
      kind: 'language',
      displayName: 'DeepSeek-V4-Pro',
      contextSize: 1_000_000,
    },
    PRICING_DOCS,
  ),
  exactModel(
    'deepseek-v4-flash-vision-exp',
    {
      kind: 'language',
      displayName: 'DeepSeek-V4-Flash-Vision-Exp',
      contextSize: 1_000_000,
      capabilities: {
        input: {
          image: {
            mediaTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
            maxBytes: 67_108_864,
            maxWidth: 8_192,
            maxHeight: 8_192,
            maxTotalPixels: 67_108_864,
          },
        },
      },
    },
    'https://api-docs.deepseek.com/guides/vision/',
  ),
];

export const deepSeekProviderDefinition: ProviderDefinition = {
  type: 'deepseek',
  usageGuidance:
    'Use for DeepSeek models through the official OpenAI-compatible API. Use Chat Completions for custom gateways.',
  metadata: {
    displayName: 'DeepSeek',
    description: 'DeepSeek models served through the official API.',
  },
  resolveModelMetadata: (modelId) =>
    resolveCatalogMetadata(modelId, MODEL_CATALOG, undefined, [
      {
        prefixes: ['deepseek-'],
        includesAny: ['vision', '-vl'],
        metadata: {
          kind: 'language',
          capabilities: { input: { image: {} } },
        },
      },
      {
        prefixes: ['deepseek-'],
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
