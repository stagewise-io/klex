import type { ProviderDefinition } from '../provider-registry';
import { exactModel, resolveCatalogMetadata } from './model-catalog-helpers';
import {
  createOpenAiCompatibleLanguageModel,
  discoverOpenAiCompatibleModels,
  testDiscoveryConnection,
} from './shared';

const BASE_URL = 'https://api.mistral.ai/v1';
const IMAGE_CAPABILITY = {
  mediaTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
  maxBytes: 20_000_000,
};
const MODEL_CATALOG = [
  ...(
    [
      ['mistral-medium-3-5', 'Mistral Medium 3.5', 'mistral-medium-3-5-26-04'],
      ['mistral-small-2603', 'Mistral Small 4', 'mistral-small-4-0-26-03'],
      ['mistral-large-2512', 'Mistral Large 3', 'mistral-large-3-25-12'],
      ['ministral-14b-2512', 'Ministral 3 14B', 'ministral-3-14b-25-12'],
      ['ministral-8b-2512', 'Ministral 3 8B', 'ministral-3-8b-25-12'],
      ['ministral-3b-2512', 'Ministral 3 3B', 'ministral-3-3b-25-12'],
    ] as const
  ).map(([modelId, displayName, docsId]) =>
    exactModel(
      modelId,
      {
        kind: 'language',
        displayName,
        contextSize: 262_144,
        capabilities: { input: { image: IMAGE_CAPABILITY } },
      },
      `https://docs.mistral.ai/models/${docsId}`,
    ),
  ),
  ...(
    [
      ['mistral-ocr-4-1', 'Mistral OCR 4.1', 'ocr-4-1'],
      ['mistral-ocr-4-0', 'Mistral OCR 4.0', 'ocr-4-0'],
      ['mistral-ocr-2512', 'Mistral OCR 3', 'ocr-3-25-12'],
    ] as const
  ).map(([modelId, displayName, docsId]) =>
    exactModel(
      modelId,
      {
        kind: 'language',
        displayName,
        capabilities: {
          input: {
            image: {
              mediaTypes: [
                'image/png',
                'image/jpeg',
                'image/tiff',
                'image/bmp',
                'image/gif',
                'image/webp',
              ],
            },
          },
        },
      },
      `https://docs.mistral.ai/models/${docsId}`,
    ),
  ),
  exactModel(
    'voxtral-mini-2602',
    {
      kind: 'speech-to-text',
      displayName: 'Voxtral Mini Transcribe 2',
      capabilities: {
        input: {
          audio: {
            mediaTypes: [
              'audio/wav',
              'audio/mpeg',
              'audio/flac',
              'audio/ogg',
              'audio/webm',
            ],
            maxBytes: 500_000_000,
            maxLengthSeconds: 3_600,
          },
        },
        voice: { stt: true },
      },
    },
    'https://docs.mistral.ai/models/voxtral-mini-transcribe-26-02',
  ),
  exactModel(
    'voxtral-mini-transcribe-realtime-2602',
    {
      kind: 'speech-to-text',
      displayName: 'Voxtral Mini Transcribe Realtime',
      capabilities: { input: { audio: {} }, voice: { stt: true } },
    },
    'https://docs.mistral.ai/models/voxtral-mini-transcribe-realtime-26-02',
  ),
  exactModel(
    'voxtral-small-2507',
    {
      kind: 'language',
      displayName: 'Voxtral Small',
      contextSize: 32_768,
      capabilities: {
        input: {
          audio: {
            mediaTypes: [
              'audio/wav',
              'audio/mpeg',
              'audio/flac',
              'audio/ogg',
              'audio/webm',
            ],
            maxBytes: 500_000_000,
            maxLengthSeconds: 3_600,
          },
        },
      },
    },
    'https://docs.mistral.ai/models/voxtral-small-25-07',
  ),
  exactModel(
    'codestral-2508',
    { kind: 'language', displayName: 'Codestral', contextSize: 131_072 },
    'https://docs.mistral.ai/models/codestral-25-08',
  ),
  exactModel(
    'mistralai/Shieldstral-1.0-3B',
    {
      kind: 'moderation',
      displayName: 'Shieldstral 1.0 3B',
      contextSize: 32_768,
      capabilities: { input: { image: {} } },
    },
    'https://docs.mistral.ai/models/shieldstral-1-0',
  ),
  exactModel(
    'mistral-moderation-2603',
    {
      kind: 'moderation',
      displayName: 'Mistral Moderation 2',
      contextSize: 131_072,
    },
    'https://docs.mistral.ai/models/mistral-moderation-26-03',
  ),
  exactModel(
    'labs-leanstral-1-5',
    { kind: 'language', displayName: 'Leanstral 1.5', contextSize: 262_144 },
    'https://docs.mistral.ai/models/leanstral-1-5',
  ),
];

export const mistralProviderDefinition: ProviderDefinition = {
  type: 'mistral',
  usageGuidance:
    'Use for Mistral AI models through the official OpenAI-compatible API. Use Chat Completions for custom gateways.',
  metadata: {
    displayName: 'Mistral AI',
    description: 'Mistral models served through the official API.',
  },
  resolveModelMetadata: (modelId) =>
    resolveCatalogMetadata(modelId, MODEL_CATALOG, undefined, [
      {
        prefixes: ['voxtral-'],
        metadata: { kind: 'language', capabilities: { input: { audio: {} } } },
      },
      {
        prefixes: ['pixtral-', 'ocr-'],
        metadata: {
          kind: 'language',
          capabilities: { input: { image: IMAGE_CAPABILITY } },
        },
      },
      {
        prefixes: ['mistral-', 'ministral-'],
        excludesAny: ['embed', 'moderation'],
        metadata: {
          kind: 'language',
          capabilities: { input: { image: IMAGE_CAPABILITY } },
        },
      },
      {
        prefixes: ['codestral-', 'devstral-', 'leanstral-'],
        metadata: { kind: 'language', capabilities: { input: {} } },
      },
      { prefixes: ['mistral-embed'], metadata: { kind: 'embedding' } },
      { prefixes: ['mistral-moderation'], metadata: { kind: 'moderation' } },
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
