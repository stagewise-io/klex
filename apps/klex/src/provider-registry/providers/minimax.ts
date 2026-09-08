import type { ProviderDefinition } from '../provider-registry';
import { exactModel, resolveCatalogMetadata } from './model-catalog-helpers';
import {
  createOpenAiCompatibleLanguageModel,
  discoverOpenAiCompatibleModels,
  testDiscoveryConnection,
} from './shared';

const BASE_URL = 'https://api.minimax.io/v1';
const MODEL_DOCS = 'https://platform.minimax.io/docs/guides/text-generation';
const MODEL_CATALOG = [
  ...(
    [
      ['MiniMax-M2.7', 'MiniMax M2.7', 204_800],
      ['MiniMax-M2.7-highspeed', 'MiniMax M2.7 Highspeed', 204_800],
      ['MiniMax-M2.5', 'MiniMax M2.5', 204_800],
      ['MiniMax-M2.5-highspeed', 'MiniMax M2.5 Highspeed', 204_800],
      ['MiniMax-M2.1', 'MiniMax M2.1', 204_800],
      ['MiniMax-M2.1-highspeed', 'MiniMax M2.1 Highspeed', 204_800],
      ['MiniMax-M2', 'MiniMax M2', 204_800],
      ['M2-her', 'M2-her', 65_536],
    ] as const
  ).map(([modelId, displayName, contextSize]) =>
    exactModel(
      modelId,
      { kind: 'language', displayName, contextSize },
      MODEL_DOCS,
    ),
  ),
  exactModel(
    'MiniMax-M3',
    {
      kind: 'language',
      displayName: 'MiniMax M3',
      contextSize: 1_000_000,
      capabilities: { input: { image: {} } },
    },
    MODEL_DOCS,
  ),
];

export function resolveMinimaxModelMetadata(modelId: string) {
  return resolveCatalogMetadata(modelId, MODEL_CATALOG, undefined, [
    {
      prefixes: ['minimax-m'],
      patterns: [
        /^minimax-m(?:[3-9]|\d{2,})(?:[.-]|$)/,
        /(?:vision|-vl)(?:-|$)/,
      ],
      metadata: { kind: 'language', capabilities: { input: { image: {} } } },
      documentationUrl: MODEL_DOCS,
    },
    {
      prefixes: ['minimax-m', 'm2-'],
      metadata: { kind: 'language', capabilities: { input: {} } },
      documentationUrl: MODEL_DOCS,
    },
  ]);
}

export const minimaxProviderDefinition: ProviderDefinition = {
  type: 'minimax',
  usageGuidance:
    'Use for MiniMax models through the official OpenAI-compatible API. Use the coding-plan type for that subscription.',
  metadata: {
    displayName: 'MiniMax',
    description: 'MiniMax models served through the official API.',
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
