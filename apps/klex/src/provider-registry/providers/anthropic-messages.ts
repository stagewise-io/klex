import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModelV4 } from '@ai-sdk/provider';

import type {
  ProviderDefinition,
  ProviderInstance,
} from '../provider-registry';
import { resolveAnthropicModelMetadata } from './anthropic';
import { providerHeaders, setting, testModelConnection } from './shared';

export const anthropicMessagesProviderDefinition: ProviderDefinition = {
  type: 'anthropic-messages',
  usageGuidance:
    'Use for a custom endpoint implementing the Anthropic Messages protocol. Prefer Anthropic for the official API.',
  metadata: {
    displayName: 'Anthropic Messages API',
    description:
      'A custom endpoint implementing the Anthropic Messages protocol.',
  },
  resolveModelMetadata: resolveAnthropicModelMetadata,
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
  return createAnthropic({
    ...(setting(instance, 'baseUrl') && {
      baseURL: setting(instance, 'baseUrl'),
    }),
    apiKey: setting(instance, 'apiKey') ?? '',
    headers: providerHeaders(instance, 'anthropic'),
  }).languageModel(modelId);
}
