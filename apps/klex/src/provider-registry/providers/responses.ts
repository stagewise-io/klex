import { createOpenResponses } from '@ai-sdk/open-responses';
import type { LanguageModelV4 } from '@ai-sdk/provider';

import type {
  ProviderDefinition,
  ProviderInstance,
} from '../provider-registry';
import { resolveCatalogMetadata } from './model-catalog-helpers';
import {
  providerHeaders,
  requiredSetting,
  responsesUrl,
  setting,
  testModelConnection,
} from './shared';

export const responsesProviderDefinition: ProviderDefinition = {
  type: 'responses',
  usageGuidance:
    'Use for a custom endpoint implementing the OpenAI Responses protocol. Prefer OpenAI for the official API.',
  metadata: {
    displayName: 'Responses API',
    description:
      'A custom endpoint implementing the OpenAI Responses protocol.',
  },
  resolveModelMetadata: (modelId) =>
    resolveCatalogMetadata(modelId, [], modelId),
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
  return createOpenResponses({
    name: instance.type,
    url: responsesUrl(requiredSetting(instance, 'baseUrl')),
    apiKey: setting(instance, 'apiKey'),
    headers: providerHeaders(instance, 'openai'),
  }).languageModel(modelId);
}
