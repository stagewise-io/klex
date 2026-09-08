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
  fetchJson,
  isRecord,
  modelListUrl,
  providerHeaders,
  sanitizedError,
  setting,
  testDiscoveryConnection,
  unavailable,
} from './shared';

const BASE_URL = 'https://openrouter.ai/api/v1';

export const openRouterProviderDefinition: ProviderDefinition = {
  type: 'openrouter',
  usageGuidance:
    'Use for OpenRouter model routing. Optional application URL and name settings identify traffic to OpenRouter.',
  metadata: {
    displayName: 'OpenRouter',
    description: 'Models routed through the OpenRouter gateway.',
    documentationUrl: 'https://openrouter.ai/docs',
  },
  resolveModelMetadata: (modelId) =>
    resolveCatalogMetadata(modelId, [], modelId),
  createLanguageModel: (instance, modelId) =>
    createOpenAiCompatibleLanguageModel(
      instance,
      modelId,
      BASE_URL,
      attributionHeaders(instance),
    ),
  discoverModels,
  testConnection: (instance, signal) =>
    testDiscoveryConnection(instance, BASE_URL, () =>
      discoverModels(instance, signal),
    ),
};

async function discoverModels(
  instance: ProviderInstance,
  signal: AbortSignal,
): Promise<ProviderOperationResult<readonly ProviderModel[]>> {
  try {
    const body = await fetchJson(
      modelListUrl(instance, BASE_URL),
      {
        ...providerHeaders(instance, 'openai'),
        ...attributionHeaders(instance),
      },
      signal,
    );
    if (!isRecord(body) || !Array.isArray(body.data)) return available([]);
    return available(
      body.data.flatMap((item) => {
        if (!isRecord(item) || typeof item.id !== 'string') return [];
        const architecture = isRecord(item.architecture)
          ? item.architecture
          : undefined;
        const inputModalities = stringArray(architecture?.input_modalities);
        const outputModalities = stringArray(architecture?.output_modalities);
        const supportedParameters = stringArray(item.supported_parameters);
        const tools = supportedParameters.includes('tools');
        const reasoning =
          supportedParameters.includes('reasoning') ||
          supportedParameters.includes('reasoning_effort') ||
          supportedParameters.includes('include_reasoning');
        const kind =
          outputModalities.includes('image') &&
          !outputModalities.includes('text')
            ? ('image-generation' as const)
            : outputModalities.includes('text')
              ? ('language' as const)
              : undefined;
        return [
          {
            modelId: item.id,
            ...(kind && { kind }),
            ...((architecture || supportedParameters.length > 0) && {
              capabilities: {
                ...(architecture && {
                  input: {
                    ...(inputModalities.includes('image') && { image: {} }),
                    ...(inputModalities.includes('audio') && { audio: {} }),
                  },
                }),
                ...(tools && { tools: true }),
                ...(reasoning && { reasoning: true }),
              },
            }),
            ...(typeof item.name === 'string' && { displayName: item.name }),
            ...(typeof item.context_length === 'number' && {
              contextSize: item.context_length,
            }),
          },
        ];
      }),
    );
  } catch (error) {
    return unavailable('discovery_failed', sanitizedError(error));
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function attributionHeaders(
  instance: ProviderInstance,
): Record<string, string> {
  return {
    ...(setting(instance, 'httpReferer') && {
      'HTTP-Referer': setting(instance, 'httpReferer'),
    }),
    ...(setting(instance, 'appName') && {
      'X-Title': setting(instance, 'appName'),
    }),
  };
}
