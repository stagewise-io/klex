import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import type { LanguageModelV4 } from '@ai-sdk/provider';

import type {
  ProviderDefinition,
  ProviderInstance,
} from '../provider-registry';
import { resolveCatalogMetadata } from './model-catalog-helpers';
import { setting, testModelConnection } from './shared';

export const amazonBedrockProviderDefinition: ProviderDefinition = {
  type: 'amazon-bedrock',
  usageGuidance:
    'Use for foundation models hosted by Amazon Bedrock. Configure model IDs manually and select the appropriate AWS authentication mode.',
  metadata: {
    displayName: 'Amazon Bedrock',
    description: 'Foundation models hosted through Amazon Bedrock.',
    documentationUrl: 'https://docs.aws.amazon.com/bedrock/',
  },
  resolveModelMetadata: (modelId) =>
    resolveCatalogMetadata(modelId, [], modelId, [
      {
        prefixes: ['anthropic.claude'],
        metadata: {
          kind: 'language',
          capabilities: { input: { image: {} } },
        },
      },
      {
        prefixes: ['amazon.nova'],
        excludesAny: ['micro'],
        metadata: {
          kind: 'language',
          capabilities: { input: { image: {} } },
        },
      },
      {
        prefixes: [
          'amazon.',
          'anthropic.',
          'cohere.',
          'deepseek.',
          'meta.',
          'mistral.',
          'openai.',
          'qwen.',
        ],
        includesAny: ['vision', '.vl', '-vl', 'multimodal'],
        metadata: {
          kind: 'language',
          capabilities: { input: { image: {} } },
        },
      },
      {
        prefixes: [
          'amazon.',
          'anthropic.',
          'cohere.',
          'deepseek.',
          'meta.',
          'mistral.',
          'openai.',
          'qwen.',
        ],
        metadata: { kind: 'language', capabilities: { input: {} } },
      },
    ]),
  createLanguageModel,
  testConnection: (instance, signal) =>
    testModelConnection(
      instance,
      `https://bedrock-runtime.${setting(instance, 'region') ?? 'us-east-1'}.amazonaws.com`,
      (modelId) => createLanguageModel(instance, modelId),
      signal,
    ),
};

function createLanguageModel(
  instance: ProviderInstance,
  modelId: string,
): LanguageModelV4 {
  const authMode = setting(instance, 'authMode');
  return createAmazonBedrock({
    region: setting(instance, 'region') ?? 'us-east-1',
    ...(authMode === 'api-key' &&
      setting(instance, 'apiKey') && { apiKey: setting(instance, 'apiKey') }),
    ...(authMode === 'access-keys' &&
      setting(instance, 'accessKeyId') && {
        accessKeyId: setting(instance, 'accessKeyId'),
      }),
    ...(authMode === 'access-keys' &&
      setting(instance, 'secretAccessKey') && {
        secretAccessKey: setting(instance, 'secretAccessKey'),
      }),
    ...(authMode === 'access-keys' &&
      setting(instance, 'sessionToken') && {
        sessionToken: setting(instance, 'sessionToken'),
      }),
  }).languageModel(modelId);
}
