import { createGoogle } from '@ai-sdk/google';
import type { LanguageModelV4 } from '@ai-sdk/provider';

import type {
  ProviderDefinition,
  ProviderInstance,
} from '../provider-registry';
import { resolveGoogleModelMetadata } from './google-gemini';
import { customHeaders, setting, testModelConnection } from './shared';

export const googleGenerativeProviderDefinition: ProviderDefinition = {
  type: 'google-generative',
  usageGuidance:
    'Use for a custom endpoint implementing the Google Generative AI protocol. Prefer Google Gemini for the official API.',
  metadata: {
    displayName: 'Google Generative AI API',
    description:
      'A custom endpoint implementing the Google Generative AI protocol.',
  },
  resolveModelMetadata: resolveGoogleModelMetadata,
  createLanguageModel,
  testConnection: (instance, signal) =>
    testModelConnection(
      instance,
      'http://localhost',
      (modelId) => createLanguageModel(instance, modelId),
      signal,
    ),
};

function createLanguageModel(
  instance: ProviderInstance,
  modelId: string,
): LanguageModelV4 {
  return createGoogle({
    ...(setting(instance, 'baseUrl') && {
      baseURL: setting(instance, 'baseUrl'),
    }),
    apiKey: setting(instance, 'apiKey') ?? '',
    headers: customHeaders(instance),
  }).languageModel(modelId);
}
