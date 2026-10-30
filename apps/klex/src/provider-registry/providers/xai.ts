import type {
  ProviderDefinition,
  ProviderInstance,
  ProviderModel,
  ProviderOperationResult,
} from '../provider-registry';
import { resolveCatalogMetadata } from './model-catalog-helpers';
import {
  available,
  createOpenAiCompatibleLanguageModel,
  discoverOpenAiCompatibleModels,
  fetchJson,
  isRecord,
  parseModelCreatedAt,
  providerHeaders,
  sanitizedError,
  setting,
  testDiscoveryConnection,
  unavailable,
} from './shared';

const BASE_URL = 'https://api.x.ai/v1';

export const xaiProviderDefinition: ProviderDefinition = {
  type: 'xai',
  usageGuidance:
    'Use for xAI models through the official OpenAI-compatible API. Use Chat Completions for a custom proxy endpoint.',
  metadata: {
    displayName: 'xAI',
    description: 'Grok models served through the official xAI API.',
  },
  resolveModelMetadata: (modelId) =>
    resolveCatalogMetadata(modelId, [], undefined, [
      {
        prefixes: ['grok-'],
        metadata: {
          kind: 'language',
          capabilities: { input: { image: {} } },
        },
        documentationUrl: 'https://docs.x.ai/docs/models',
      },
    ]),
  createLanguageModel: (instance, modelId) =>
    createOpenAiCompatibleLanguageModel(instance, modelId, BASE_URL),
  discoverModels,
  testConnection: (instance, signal) =>
    testDiscoveryConnection(instance, BASE_URL, () =>
      discoverModels(instance, signal),
    ),
};

/**
 * xAI's language-model list reports input modalities per model:
 * https://docs.x.ai/docs/api-reference#list-language-models
 * Proxies without that route fall back to the plain `/models` list.
 */
async function discoverModels(
  instance: ProviderInstance,
  signal: AbortSignal,
): Promise<ProviderOperationResult<readonly ProviderModel[]>> {
  const baseUrl = (setting(instance, 'baseUrl') ?? BASE_URL).replace(/\/$/, '');
  let body: unknown;
  try {
    body = await fetchJson(
      new URL(`${baseUrl}/language-models`),
      providerHeaders(instance, 'openai'),
      signal,
    );
  } catch (error) {
    if (
      !signal.aborted &&
      sanitizedError(error) === 'Provider returned HTTP 404'
    )
      return discoverOpenAiCompatibleModels(instance, BASE_URL, signal);
    return unavailable('discovery_failed', sanitizedError(error));
  }
  if (!isRecord(body) || !Array.isArray(body.models)) return available([]);
  return available(
    body.models.flatMap((item): ProviderModel[] => {
      if (!isRecord(item) || typeof item.id !== 'string') return [];
      const input = modalities(item.input_modalities);
      const output = modalities(item.output_modalities);
      if (output && !output.includes('text')) return [];
      const createdAt = parseModelCreatedAt(item.created);
      return [
        {
          modelId: item.id,
          kind: 'language',
          ...(createdAt && { createdAt }),
          ...(input?.includes('image') && {
            capabilities: { input: { image: {} } },
          }),
        },
      ];
    }),
  );
}

function modalities(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : undefined;
}
