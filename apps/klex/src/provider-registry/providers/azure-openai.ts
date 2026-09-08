import { createAzure } from '@ai-sdk/azure';
import type { LanguageModelV4 } from '@ai-sdk/provider';

import type {
  ProviderDefinition,
  ProviderInstance,
} from '../provider-registry';
import {
  customHeaders,
  requiredSetting,
  setting,
  testModelConnection,
} from './shared';

export const azureOpenAiProviderDefinition: ProviderDefinition = {
  type: 'azure-openai',
  usageGuidance:
    'Use for OpenAI models deployed in Microsoft Azure. Model IDs are Azure deployment names and must be configured manually.',
  metadata: {
    displayName: 'Microsoft Azure OpenAI',
    description: 'OpenAI models deployed through Microsoft Azure.',
    documentationUrl: 'https://learn.microsoft.com/azure/ai-services/openai/',
  },
  createLanguageModel,
  testConnection: (instance, signal) =>
    testModelConnection(
      instance,
      azureTarget(instance),
      (modelId) => createLanguageModel(instance, modelId),
      signal,
    ),
};

function azureTarget(instance: ProviderInstance): string {
  const resourceName = setting(instance, 'resourceName');
  return resourceName
    ? `https://${resourceName}.openai.azure.com`
    : 'https://azure.microsoft.com';
}

function createLanguageModel(
  instance: ProviderInstance,
  modelId: string,
): LanguageModelV4 {
  return createAzure({
    ...(setting(instance, 'resourceName') && {
      resourceName: setting(instance, 'resourceName'),
    }),
    ...(setting(instance, 'baseUrl') && {
      baseURL: setting(instance, 'baseUrl'),
    }),
    apiKey: requiredSetting(instance, 'apiKey'),
    ...(setting(instance, 'apiVersion') && {
      apiVersion: setting(instance, 'apiVersion'),
    }),
    useDeploymentBasedUrls:
      typeof instance.settings.useDeploymentBasedUrls === 'boolean'
        ? instance.settings.useDeploymentBasedUrls
        : false,
    headers: customHeaders(instance),
  }).languageModel(modelId);
}
