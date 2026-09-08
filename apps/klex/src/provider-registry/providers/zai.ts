import type { ProviderDefinition } from '../provider-registry';
import { exactModel, resolveCatalogMetadata } from './model-catalog-helpers';
import {
  createOpenAiCompatibleLanguageModel,
  discoverOpenAiCompatibleModels,
  testDiscoveryConnection,
} from './shared';

const BASE_URL = 'https://api.z.ai/api/paas/v4';
const PRICING_DOCS = 'https://docs.z.ai/guides/overview/pricing';
const MODEL_CATALOG = [
  ...(
    [
      ['glm-5.3', 'GLM-5.3', 1_000_000],
      ['glm-5.2', 'GLM-5.2', 1_000_000],
      ['glm-5.1', 'GLM-5.1', 200_000],
      ['glm-5', 'GLM-5', 200_000],
      ['glm-4.7', 'GLM-4.7', 200_000],
      ['glm-4.7-flashx', 'GLM-4.7 FlashX', 200_000],
      ['glm-4.7-flash', 'GLM-4.7 Flash', 200_000],
      ['glm-4.6', 'GLM-4.6', 200_000],
      ['glm-4.5', 'GLM-4.5', 131_072],
      ['glm-4.5-x', 'GLM-4.5-X', 131_072],
      ['glm-4.5-air', 'GLM-4.5-Air', 131_072],
      ['glm-4.5-airx', 'GLM-4.5-AirX', 131_072],
      ['glm-4.5-flash', 'GLM-4.5-Flash', 131_072],
      ['glm-4-32b-0414-128k', 'GLM-4-32B-0414-128K', 131_072],
    ] as const
  ).map(([modelId, displayName, contextSize]) =>
    exactModel(
      modelId,
      { kind: 'language', displayName, contextSize },
      modelId === 'glm-5.3'
        ? 'https://docs.z.ai/guides/llm/glm-5.3'
        : PRICING_DOCS,
    ),
  ),
  ...(
    [
      ['glm-5.3-flash', 'GLM-5.3 Flash', 1_000_000, 'glm-5.3-flash'],
      ['glm-4.6v', 'GLM-4.6V', 131_072, 'glm-4.6v'],
      ['glm-4.6v-flashx', 'GLM-4.6V FlashX', 131_072, 'glm-4.6v'],
      ['glm-4.6v-flash', 'GLM-4.6V Flash', 131_072, 'glm-4.6v'],
    ] as const
  ).map(([modelId, displayName, contextSize, docsId]) =>
    exactModel(
      modelId,
      {
        kind: 'language',
        displayName,
        contextSize,
        capabilities: { input: { image: {} } },
      },
      `https://docs.z.ai/guides/vlm/${docsId}`,
    ),
  ),
  exactModel(
    'glm-4.5v',
    {
      kind: 'language',
      displayName: 'GLM-4.5V',
      capabilities: { input: { image: {} } },
    },
    'https://docs.z.ai/guides/vlm/glm-4.5v',
  ),
  exactModel(
    'glm-ocr',
    {
      kind: 'language',
      displayName: 'GLM-OCR',
      capabilities: {
        input: {
          image: {
            mediaTypes: ['image/jpeg', 'image/png'],
            maxBytes: 10_000_000,
          },
        },
      },
    },
    'https://docs.z.ai/guides/vlm/glm-ocr',
  ),
  exactModel(
    'glm-asr-2512',
    {
      kind: 'speech-to-text',
      displayName: 'GLM-ASR-2512',
      capabilities: {
        input: {
          audio: {
            mediaTypes: ['audio/wav', 'audio/mpeg'],
            maxBytes: 25_000_000,
            maxLengthSeconds: 30,
          },
        },
        voice: { stt: true },
      },
    },
    'https://docs.z.ai/guides/audio/glm-asr-2512',
  ),
];

export function resolveZaiModelMetadata(modelId: string) {
  return resolveCatalogMetadata(modelId, MODEL_CATALOG, undefined, [
    {
      prefixes: ['glm-'],
      includesAny: ['asr', 'transcribe'],
      metadata: {
        kind: 'speech-to-text',
        capabilities: { input: { audio: {} }, voice: { stt: true } },
      },
      documentationUrl: PRICING_DOCS,
    },
    {
      prefixes: ['glm-'],
      patterns: [/^glm-(?:\d+(?:\.\d+)?v(?:-|$)|.*(?:vision|ocr))/],
      metadata: { kind: 'language', capabilities: { input: { image: {} } } },
      documentationUrl: PRICING_DOCS,
    },
    {
      prefixes: ['glm-'],
      metadata: { kind: 'language', capabilities: { input: {} } },
      documentationUrl: PRICING_DOCS,
    },
  ]);
}

export const zaiProviderDefinition: ProviderDefinition = {
  type: 'zai',
  usageGuidance:
    'Use for Z.ai GLM models through the official OpenAI-compatible API. Use the coding-plan type for that subscription.',
  metadata: {
    displayName: 'Z.ai / GLM',
    description: 'GLM models served through the Z.ai public API.',
  },
  resolveModelMetadata: resolveZaiModelMetadata,
  createLanguageModel: (instance, modelId) =>
    createOpenAiCompatibleLanguageModel(instance, modelId, BASE_URL),
  discoverModels: (instance, signal) =>
    discoverOpenAiCompatibleModels(instance, BASE_URL, signal),
  testConnection: (instance, signal) =>
    testDiscoveryConnection(instance, BASE_URL, () =>
      discoverOpenAiCompatibleModels(instance, BASE_URL, signal),
    ),
};
