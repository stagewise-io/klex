import { createGoogle } from '@ai-sdk/google';
import type { LanguageModelV4 } from '@ai-sdk/provider';

import type {
  ProviderDefinition,
  ProviderInstance,
  ProviderModel,
  ProviderOperationResult,
} from '../provider-registry';
import { exactModel, resolveCatalogMetadata } from './model-catalog-helpers';
import {
  available,
  customHeaders,
  fetchJson,
  isRecord,
  modelListUrl,
  requiredSetting,
  sanitizedError,
  setting,
  testDiscoveryConnection,
  unavailable,
} from './shared';

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const MODEL_DOCS = 'https://ai.google.dev/gemini-api/docs/models';
const IMAGE_CAPABILITY = {
  mediaTypes: [
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/heic',
    'image/heif',
  ],
  maxBytes: 20_000_000,
};
const AUDIO_CAPABILITY = {
  mediaTypes: [
    'audio/wav',
    'audio/mp3',
    'audio/aiff',
    'audio/aac',
    'audio/ogg',
    'audio/flac',
    'audio/mpeg',
    'audio/m4a',
    'audio/l16',
    'audio/opus',
    'audio/alaw',
    'audio/mulaw',
    'audio/webm',
  ],
  maxBytes: 20_000_000,
  maxLengthSeconds: 34_200,
};
const MODEL_CATALOG = [
  ...(
    [
      ['gemini-3.8-flash', 'Gemini 3.8 Flash'],
      ['gemini-3.7-flash', 'Gemini 3.7 Flash'],
      ['gemini-3.6-flash', 'Gemini 3.6 Flash'],
      ['gemini-3.5-flash', 'Gemini 3.5 Flash'],
      ['gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite'],
      ['gemini-3.1-flash-lite', 'Gemini 3.1 Flash-Lite'],
      ['gemini-3.1-pro-preview', 'Gemini 3.1 Pro'],
      ['gemini-3-flash-preview', 'Gemini 3 Flash'],
      ['gemini-2.5-flash', 'Gemini 2.5 Flash'],
      ['gemini-2.5-flash-lite', 'Gemini 2.5 Flash-Lite'],
      ['gemini-2.5-pro', 'Gemini 2.5 Pro'],
    ] as const
  ).map(([modelId, displayName]) =>
    exactModel(
      modelId,
      {
        kind: 'language',
        displayName,
        contextSize: 1_048_576,
        capabilities: {
          input: { image: IMAGE_CAPABILITY, audio: AUDIO_CAPABILITY },
        },
      },
      `${MODEL_DOCS}/${modelId}`,
    ),
  ),
  exactModel(
    'gemini-2.5-computer-use-preview-10-2025',
    {
      kind: 'language',
      displayName: 'Gemini 2.5 Computer Use',
      contextSize: 128_000,
      capabilities: { input: { image: IMAGE_CAPABILITY } },
    },
    `${MODEL_DOCS}/gemini-2.5-computer-use-preview-10-2025`,
  ),
  exactModel(
    'gemini-robotics-er-2-preview',
    {
      kind: 'language',
      displayName: 'Gemini Robotics ER 2',
      contextSize: 131_072,
      capabilities: {
        input: { image: IMAGE_CAPABILITY, audio: AUDIO_CAPABILITY },
      },
    },
    'https://ai.google.dev/gemini-api/docs/robotics-overview',
  ),
  exactModel(
    'gemini-robotics-er-2-streaming-preview',
    {
      kind: 'language',
      displayName: 'Gemini Robotics ER 2 Streaming',
      contextSize: 131_072,
      capabilities: { input: { image: {}, audio: {} } },
    },
    'https://ai.google.dev/gemini-api/docs/robotics-overview',
  ),
  exactModel(
    'gemini-3.1-flash-live-preview',
    {
      kind: 'speech-to-speech',
      displayName: 'Gemini 3.1 Flash Live',
      contextSize: 131_072,
      capabilities: {
        input: { image: {}, audio: {} },
        voice: { sts: true },
      },
    },
    `${MODEL_DOCS}/gemini-3.1-flash-live-preview`,
  ),
  ...(
    [
      ['gemini-3.5-live-translate-preview', 'Gemini 3.5 Live Translate'],
      [
        'gemini-2.5-flash-native-audio-preview-12-2025',
        'Gemini 2.5 Flash Live',
      ],
    ] as const
  ).map(([modelId, displayName]) =>
    exactModel(
      modelId,
      {
        kind: 'speech-to-speech',
        displayName,
        contextSize: 131_072,
        capabilities: { input: { audio: {} }, voice: { sts: true } },
      },
      `${MODEL_DOCS}/${modelId}`,
    ),
  ),
  exactModel(
    'gemini-3.5-transcribe',
    {
      kind: 'speech-to-text',
      displayName: 'Gemini 3.5 Transcribe',
      capabilities: {
        input: {
          audio: {
            ...AUDIO_CAPABILITY,
            maxLengthSeconds: 3_600,
          },
        },
        voice: { stt: true },
      },
    },
    `${MODEL_DOCS}/gemini-3.5-transcribe`,
  ),
  exactModel(
    'gemini-3.5-transcribe-live',
    {
      kind: 'speech-to-text',
      displayName: 'Gemini 3.5 Transcribe Live',
      capabilities: {
        input: {
          audio: {
            mediaTypes: AUDIO_CAPABILITY.mediaTypes,
            maxLengthSeconds: 600,
          },
        },
        voice: { stt: true },
      },
    },
    `${MODEL_DOCS}/gemini-3.5-transcribe`,
  ),
];

export function resolveGoogleModelMetadata(modelId: string) {
  const normalized = modelId.replace(/^models\//, '');
  return resolveCatalogMetadata(normalized, MODEL_CATALOG, undefined, [
    {
      prefixes: ['gemini-'],
      includesAny: ['live', 'native-audio'],
      metadata: {
        kind: 'speech-to-speech',
        capabilities: {
          input: { image: IMAGE_CAPABILITY, audio: AUDIO_CAPABILITY },
          voice: { sts: true },
        },
      },
      documentationUrl: MODEL_DOCS,
    },
    {
      prefixes: ['gemini-'],
      includesAny: ['transcribe'],
      metadata: {
        kind: 'speech-to-text',
        capabilities: {
          input: { audio: AUDIO_CAPABILITY },
          voice: { stt: true },
        },
      },
      documentationUrl: MODEL_DOCS,
    },
    {
      prefixes: ['gemini-'],
      includesAny: ['-image'],
      metadata: { kind: 'image-generation' },
      documentationUrl: MODEL_DOCS,
    },
    {
      prefixes: ['gemini-'],
      excludesAny: ['embedding'],
      metadata: {
        kind: 'language',
        capabilities: {
          input: { image: IMAGE_CAPABILITY, audio: AUDIO_CAPABILITY },
        },
      },
      documentationUrl: MODEL_DOCS,
    },
    {
      prefixes: ['text-embedding-', 'gemini-embedding-'],
      metadata: { kind: 'embedding' },
      documentationUrl: MODEL_DOCS,
    },
  ]);
}

export const googleGeminiProviderDefinition: ProviderDefinition = {
  type: 'google-gemini',
  usageGuidance:
    'Use for the official Google Gemini API authenticated with an API key. Use Google Vertex for Google Cloud projects.',
  metadata: {
    displayName: 'Google Gemini API',
    description: 'Gemini models served by the Google Generative Language API.',
    documentationUrl: 'https://ai.google.dev/gemini-api/docs',
  },
  resolveModelMetadata: resolveGoogleModelMetadata,
  createLanguageModel,
  discoverModels,
  testConnection: (instance, signal) =>
    testDiscoveryConnection(instance, BASE_URL, () =>
      discoverModels(instance, signal),
    ),
};

function createLanguageModel(
  instance: ProviderInstance,
  modelId: string,
): LanguageModelV4 {
  return createGoogle({
    apiKey: setting(instance, 'apiKey') ?? '',
    headers: customHeaders(instance),
  }).languageModel(modelId);
}

async function discoverModels(
  instance: ProviderInstance,
  signal: AbortSignal,
): Promise<ProviderOperationResult<readonly ProviderModel[]>> {
  try {
    const models: ProviderModel[] = [];
    let pageToken: string | undefined;
    do {
      const url = modelListUrl(instance, BASE_URL);
      url.searchParams.set('key', requiredSetting(instance, 'apiKey'));
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const body = await fetchJson(url, customHeaders(instance), signal);
      if (!isRecord(body) || !Array.isArray(body.models)) break;
      for (const item of body.models) {
        if (!isRecord(item) || typeof item.name !== 'string') continue;
        const methods = Array.isArray(item.supportedGenerationMethods)
          ? item.supportedGenerationMethods.filter(
              (method): method is string => typeof method === 'string',
            )
          : [];
        models.push({
          modelId: item.name.replace(/^models\//, ''),
          ...(methods.includes('embedContent') &&
            !methods.includes('generateContent') && {
              kind: 'embedding' as const,
            }),
          ...(methods.includes('generateContent') && {
            kind: 'language' as const,
          }),
          ...(typeof item.displayName === 'string' && {
            displayName: item.displayName,
          }),
          ...(typeof item.inputTokenLimit === 'number' && {
            contextSize: item.inputTokenLimit,
          }),
        });
      }
      pageToken =
        typeof body.nextPageToken === 'string' ? body.nextPageToken : undefined;
    } while (pageToken);
    return available(models);
  } catch (error) {
    return unavailable('discovery_failed', sanitizedError(error));
  }
}
