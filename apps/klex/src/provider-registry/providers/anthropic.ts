import { createAnthropic } from '@ai-sdk/anthropic';
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
  fetchJson,
  isRecord,
  modelListUrl,
  providerHeaders,
  sanitizedError,
  setting,
  testDiscoveryConnection,
  unavailable,
} from './shared';

const BASE_URL = 'https://api.anthropic.com/v1';
const MODEL_DOCS = 'https://platform.claude.com/docs/en/models/overview';
const IMAGE_CAPABILITY = {
  mediaTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
  maxBytes: 10_000_000,
  maxWidth: 8_000,
  maxHeight: 8_000,
  maxTotalPixels: 64_000_000,
};
const MODEL_CATALOG = (
  [
    ['claude-fable-5-1', 'Claude Fable 5.1', 1_000_000],
    ['claude-opus-5', 'Claude Opus 5', 1_000_000],
    ['claude-sonnet-5', 'Claude Sonnet 5', 1_000_000],
    ['claude-haiku-4-5-20251001', 'Claude Haiku 4.5', 200_000],
  ] as const
).map(([modelId, displayName, contextSize]) =>
  exactModel(
    modelId,
    {
      kind: 'language',
      displayName,
      contextSize,
      capabilities: { input: { image: IMAGE_CAPABILITY } },
    },
    MODEL_DOCS,
  ),
);

export function resolveAnthropicModelMetadata(modelId: string) {
  return resolveCatalogMetadata(modelId, MODEL_CATALOG, undefined, [
    {
      prefixes: ['claude-'],
      metadata: {
        kind: 'language',
        capabilities: { input: { image: IMAGE_CAPABILITY } },
      },
      documentationUrl: MODEL_DOCS,
    },
  ]);
}

export const anthropicProviderDefinition: ProviderDefinition = {
  type: 'anthropic',
  usageGuidance:
    'Use for the official Anthropic API. Choose Anthropic Messages for compatible third-party endpoints.',
  metadata: {
    displayName: 'Anthropic',
    description: 'Claude models served by the official Anthropic API.',
    documentationUrl: 'https://docs.anthropic.com',
  },
  resolveModelMetadata: resolveAnthropicModelMetadata,
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
  return createAnthropic({
    apiKey: setting(instance, 'apiKey') ?? '',
    headers: providerHeaders(instance, 'anthropic'),
  }).languageModel(modelId);
}

async function discoverModels(
  instance: ProviderInstance,
  signal: AbortSignal,
): Promise<ProviderOperationResult<readonly ProviderModel[]>> {
  try {
    const models: ProviderModel[] = [];
    let afterId: string | undefined;
    do {
      const url = modelListUrl(instance, BASE_URL);
      if (afterId) url.searchParams.set('after_id', afterId);
      const body = await fetchJson(
        url,
        providerHeaders(instance, 'anthropic'),
        signal,
      );
      if (!isRecord(body) || !Array.isArray(body.data)) break;
      for (const item of body.data) {
        if (!isRecord(item) || typeof item.id !== 'string') continue;
        const capabilities = isRecord(item.capabilities)
          ? item.capabilities
          : undefined;
        const imageInput = supports(capabilities?.image_input);
        const reasoning = supports(capabilities?.thinking);
        models.push({
          modelId: item.id,
          ...(typeof item.display_name === 'string' && {
            displayName: item.display_name,
          }),
          ...(typeof item.max_input_tokens === 'number' && {
            contextSize: item.max_input_tokens,
          }),
          ...((imageInput || reasoning) && {
            capabilities: {
              ...(imageInput && { input: { image: {} } }),
              ...(reasoning && { reasoning: true }),
            },
          }),
        });
      }
      afterId =
        body.has_more === true && typeof body.last_id === 'string'
          ? body.last_id
          : undefined;
    } while (afterId);
    return available(models);
  } catch (error) {
    return unavailable('discovery_failed', sanitizedError(error));
  }
}

function supports(value: unknown): boolean {
  return isRecord(value) && value.supported === true;
}
