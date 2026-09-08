import type { ProviderDefinition } from '../provider-registry';
import {
  createOpenAiCompatibleLanguageModel,
  discoverOpenAiCompatibleModels,
  testDiscoveryConnection,
} from './shared';
import { resolveZaiModelMetadata } from './zai';

const BASE_URL = 'https://api.z.ai/api/coding/paas/v4';

export const glmCodingPlanProviderDefinition: ProviderDefinition = {
  type: 'glm-coding-plan',
  usageGuidance:
    'Use for a GLM Coding Plan subscription. Use Z.ai / GLM for ordinary pay-as-you-go API credentials.',
  metadata: {
    displayName: 'GLM Coding Plan',
    description: 'GLM models accessed through a Z.ai Coding Plan.',
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
