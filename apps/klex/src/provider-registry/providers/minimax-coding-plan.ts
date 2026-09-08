import type { ProviderDefinition } from '../provider-registry';
import { resolveMinimaxModelMetadata } from './minimax';
import {
  createOpenAiCompatibleLanguageModel,
  discoverOpenAiCompatibleModels,
  testDiscoveryConnection,
} from './shared';

const BASE_URL = 'https://api.minimax.io/v1';

export const minimaxCodingPlanProviderDefinition: ProviderDefinition = {
  type: 'minimax-coding-plan',
  usageGuidance:
    'Use for a MiniMax Coding Plan subscription. Use MiniMax for ordinary pay-as-you-go API credentials.',
  metadata: {
    displayName: 'MiniMax Coding Plan',
    description: 'MiniMax models accessed through a Coding Plan.',
  },
  resolveModelMetadata: resolveMinimaxModelMetadata,
  createLanguageModel: (instance, modelId) =>
    createOpenAiCompatibleLanguageModel(instance, modelId, BASE_URL),
  discoverModels: (instance, signal) =>
    discoverOpenAiCompatibleModels(instance, BASE_URL, signal),
  testConnection: (instance, signal) =>
    testDiscoveryConnection(instance, BASE_URL, () =>
      discoverOpenAiCompatibleModels(instance, BASE_URL, signal),
    ),
};
