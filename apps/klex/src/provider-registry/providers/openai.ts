import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV4 } from '@ai-sdk/provider';

import type {
  ProviderDefinition,
  ProviderInstance,
} from '../provider-registry';
import { exactModel, resolveCatalogMetadata } from './model-catalog-helpers';
import {
  customHeaders,
  discoverOpenAiCompatibleModels,
  requiredSetting,
  setting,
  testDiscoveryConnection,
} from './shared';

const BASE_URL = 'https://api.openai.com/v1';
const MODEL_DOCS = 'https://developers.openai.com/api/docs/models';
const IMAGE_MEDIA_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
];
const MODEL_FALLBACKS = [
  {
    prefixes: ['gpt-realtime-', 'gpt-4o-realtime-'],
    metadata: {
      kind: 'speech-to-speech',
      capabilities: {
        input: { image: {}, audio: {} },
        voice: { sts: true },
      },
    },
    documentationUrl: MODEL_DOCS,
  },
  {
    prefixes: ['gpt-live-transcribe', 'gpt-transcribe', 'gpt-4o-transcribe'],
    metadata: {
      kind: 'speech-to-text',
      capabilities: { input: { audio: {} }, voice: { stt: true } },
    },
    documentationUrl: MODEL_DOCS,
  },
  {
    prefixes: ['whisper-'],
    metadata: {
      kind: 'speech-to-text',
      capabilities: { input: { audio: {} }, voice: { stt: true } },
    },
    documentationUrl: MODEL_DOCS,
  },
  {
    prefixes: ['tts-', 'gpt-4o-mini-tts'],
    metadata: {
      kind: 'text-to-speech',
      capabilities: { voice: { tts: true } },
    },
    documentationUrl: MODEL_DOCS,
  },
  {
    prefixes: ['gpt-audio-'],
    metadata: { kind: 'language', capabilities: { input: { audio: {} } } },
    documentationUrl: MODEL_DOCS,
  },
  {
    patterns: [/^o\d+(?:[.-]|$)/],
    excludesAny: ['audio', 'realtime', 'transcribe'],
    metadata: { kind: 'language', capabilities: { input: { image: {} } } },
    documentationUrl: MODEL_DOCS,
  },
  {
    prefixes: ['gpt-', 'chatgpt-'],
    excludesAny: ['audio', 'realtime', 'transcribe', '-tts', 'gpt-image'],
    metadata: { kind: 'language', capabilities: { input: { image: {} } } },
    documentationUrl: MODEL_DOCS,
  },
  {
    prefixes: ['text-embedding-'],
    metadata: { kind: 'embedding' },
    documentationUrl: MODEL_DOCS,
  },
  {
    prefixes: ['gpt-image-', 'dall-e-'],
    metadata: { kind: 'image-generation' },
    documentationUrl: MODEL_DOCS,
  },
  {
    prefixes: ['omni-moderation-', 'text-moderation-'],
    metadata: { kind: 'moderation' },
    documentationUrl: MODEL_DOCS,
  },
] as const;
const MODEL_CATALOG = [
  ...(
    [
      ['gpt-6-astra', 'GPT-6 Astra', 1_050_000],
      ['gpt-5.6-sol', 'GPT-5.6 Sol', 1_050_000],
      ['gpt-5.6-terra', 'GPT-5.6 Terra', 1_050_000],
      ['gpt-5.6-luna', 'GPT-5.6 Luna', 1_050_000],
      ['gpt-5.5', 'GPT-5.5', 1_050_000],
      ['gpt-5.5-pro', 'GPT-5.5 Pro', 1_050_000],
      ['gpt-5.4', 'GPT-5.4', 1_050_000],
      ['gpt-5.4-pro', 'GPT-5.4 Pro', 1_050_000],
      ['gpt-5.4-mini', 'GPT-5.4 Mini', 400_000],
      ['gpt-5.4-nano', 'GPT-5.4 Nano', 400_000],
      ['gpt-5.3-codex', 'GPT-5.3 Codex', 400_000],
      ['gpt-5.2', 'GPT-5.2', 400_000],
      ['gpt-5.2-pro', 'GPT-5.2 Pro', 400_000],
      ['gpt-5.1', 'GPT-5.1', 400_000],
      ['gpt-5', 'GPT-5', 400_000],
      ['gpt-5-mini', 'GPT-5 Mini', 400_000],
      ['gpt-5-nano', 'GPT-5 Nano', 400_000],
      ['gpt-5-pro', 'GPT-5 Pro', 400_000],
      ['o3', 'o3', 200_000],
      ['o3-pro', 'o3-pro', 200_000],
      ['gpt-4.1', 'GPT-4.1', 1_047_576],
      ['gpt-4.1-mini', 'GPT-4.1 Mini', 1_047_576],
      ['gpt-4o', 'GPT-4o', 128_000],
      ['gpt-4o-mini', 'GPT-4o Mini', 128_000],
      ['gpt-5.6-cyber', 'GPT-5.6 Cyber', 400_000],
      ['gpt-daybreak-red-latest', 'Daybreak Red', 400_000],
      ['gpt-daybreak-blue-latest', 'Daybreak Blue', 1_050_000],
    ] as const
  ).map(([modelId, displayName, contextSize]) =>
    exactModel(
      modelId,
      {
        kind: 'language',
        displayName,
        contextSize,
        capabilities: { input: { image: { mediaTypes: IMAGE_MEDIA_TYPES } } },
      },
      `${MODEL_DOCS}/${modelId}`,
    ),
  ),
  ...(
    [
      ['gpt-oss-120b', 131_072],
      ['gpt-oss-20b', 131_072],
    ] as const
  ).map(([modelId, contextSize]) =>
    exactModel(
      modelId,
      { kind: 'language', displayName: modelId, contextSize },
      `${MODEL_DOCS}/${modelId}`,
    ),
  ),
  ...(
    [
      ['gpt-realtime-2.1', 'GPT-Realtime-2.1', 128_000, true],
      ['gpt-realtime-2.1-mini', 'GPT-Realtime-2.1 Mini', 128_000, true],
      ['gpt-realtime-2', 'GPT-Realtime-2', 128_000, true],
      ['gpt-realtime-1.5', 'GPT-Realtime-1.5', 32_000, true],
      ['gpt-realtime-translate', 'GPT-Realtime-Translate', 16_000, false],
    ] as const
  ).map(([modelId, displayName, contextSize, image]) =>
    exactModel(
      modelId,
      {
        kind: 'speech-to-speech',
        displayName,
        contextSize,
        capabilities: {
          input: { ...(image && { image: {} }), audio: {} },
          voice: { sts: true },
        },
      },
      `${MODEL_DOCS}/${modelId}`,
    ),
  ),
  exactModel(
    'gpt-live-transcribe',
    {
      kind: 'speech-to-text',
      displayName: 'GPT-Live-Transcribe',
      capabilities: { input: { audio: {} }, voice: { stt: true } },
    },
    `${MODEL_DOCS}/gpt-live-transcribe`,
  ),
  exactModel(
    'gpt-realtime-whisper',
    {
      kind: 'speech-to-text',
      displayName: 'GPT-Realtime-Whisper',
      contextSize: 16_000,
      capabilities: { input: { audio: {} }, voice: { stt: true } },
    },
    `${MODEL_DOCS}/gpt-realtime-whisper`,
  ),
  exactModel(
    'gpt-audio-1.5',
    {
      kind: 'language',
      displayName: 'GPT-Audio-1.5',
      contextSize: 128_000,
      capabilities: { input: { audio: {} } },
    },
    `${MODEL_DOCS}/gpt-audio-1.5`,
  ),
  exactModel(
    'gpt-transcribe',
    {
      kind: 'speech-to-text',
      displayName: 'GPT-Transcribe',
      capabilities: {
        input: {
          audio: {
            mediaTypes: [
              'audio/mpeg',
              'audio/mp4',
              'audio/x-m4a',
              'audio/wav',
              'audio/webm',
            ],
            maxBytes: 25_000_000,
          },
        },
        voice: { stt: true },
      },
    },
    `${MODEL_DOCS}/gpt-transcribe`,
  ),
  exactModel(
    'omni-moderation-latest',
    {
      kind: 'moderation',
      displayName: 'Omni Moderation',
      capabilities: { input: { image: {} } },
    },
    `${MODEL_DOCS}/omni-moderation-latest`,
  ),
];

export function resolveOpenAiModelMetadata(modelId: string) {
  return resolveCatalogMetadata(
    modelId,
    MODEL_CATALOG,
    undefined,
    MODEL_FALLBACKS,
  );
}

export const openAiProviderDefinition: ProviderDefinition = {
  type: 'openai',
  usageGuidance:
    'Use for the official OpenAI API. Choose an OpenAI-compatible provider type for third-party gateways instead.',
  metadata: {
    displayName: 'OpenAI',
    description: 'Models served by the official OpenAI API.',
    documentationUrl: 'https://platform.openai.com/docs',
  },
  createLanguageModel,
  resolveModelMetadata: resolveOpenAiModelMetadata,
  discoverModels: (instance, signal) =>
    discoverOpenAiCompatibleModels(instance, BASE_URL, signal, false),
  testConnection: (instance, signal) =>
    testDiscoveryConnection(instance, BASE_URL, () =>
      discoverOpenAiCompatibleModels(instance, BASE_URL, signal, false),
    ),
};

function createLanguageModel(
  instance: ProviderInstance,
  modelId: string,
): LanguageModelV4 {
  return createOpenAI({
    baseURL: setting(instance, 'baseUrl') ?? BASE_URL,
    apiKey: requiredSetting(instance, 'apiKey'),
    headers: customHeaders(instance),
  }).languageModel(modelId);
}
