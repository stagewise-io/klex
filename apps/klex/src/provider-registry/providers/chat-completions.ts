import type { ProviderDefinition } from '../provider-registry';
import { resolveCatalogMetadata } from './model-catalog-helpers';
import {
  createOpenAiCompatibleLanguageModel,
  gatewayAttributionHeaders,
  testModelConnection,
} from './shared';

export const chatCompletionsProviderDefinition: ProviderDefinition = {
  type: 'chat-completions',
  usageGuidance:
    'Use for a custom OpenAI-compatible Chat Completions endpoint. Prefer a named provider type when one exists.',
  metadata: {
    displayName: 'Chat Completions API',
    description: 'A custom OpenAI-compatible chat-completions endpoint.',
  },
  resolveModelMetadata: (modelId) =>
    resolveCatalogMetadata(modelId, [], modelId),
  createLanguageModel: (instance, modelId) =>
    createOpenAiCompatibleLanguageModel(
      instance,
      modelId,
      undefined,
      gatewayAttributionHeaders(),
    ),
  testConnection: (instance, signal) =>
    testModelConnection(
      instance,
      'http://localhost',
      (modelId) => createOpenAiCompatibleLanguageModel(instance, modelId),
      signal,
    ),
};
