import type {
  ProviderDefinition,
  ProviderInstance,
  ProviderModel,
  ProviderOperationResult,
} from '../provider-registry';
import { resolveCatalogMetadata } from './model-catalog-helpers';
import { createOpenRouterEvaluationModel } from './openrouter-evaluation';
import { withPromptCaching } from './prompt-caching';
import {
  available,
  createOpenAiCompatibleLanguageModel,
  fetchJson,
  gatewayAttributionHeaders,
  isRecord,
  modelListUrl,
  parseModelCreatedAt,
  providerHeaders,
  sanitizedError,
  testDiscoveryConnection,
  unavailable,
} from './shared';

const BASE_URL = 'https://openrouter.ai/api/v1';
// Exact fallbacks also protect manually entered models before discovery runs.
const EVALUATION_MODELS = new Set([
  'perplexity/pplx-decider-v1.2',
  'perplexity/pplx-decider-flash-v1.2',
  '~perplexity/pplx-decider-latest',
  '~perplexity/pplx-decider-flash-latest',
  'morph/reflex',
]);

export const openRouterProviderDefinition: ProviderDefinition = {
  type: 'openrouter',
  usageGuidance:
    'Use for OpenRouter model routing. Decision models use the evaluation API for instinct classification, not chat. Requests are automatically attributed to Klex.',
  metadata: {
    displayName: 'OpenRouter',
    description: 'Models routed through the OpenRouter gateway.',
    documentationUrl: 'https://openrouter.ai/docs',
  },
  resolveModelMetadata: (modelId) =>
    EVALUATION_MODELS.has(modelId)
      ? { kind: 'evaluation' }
      : resolveCatalogMetadata(modelId, [], modelId),
  createEvaluationModel: createOpenRouterEvaluationModel,
  createLanguageModel: (instance, modelId) => {
    if (EVALUATION_MODELS.has(modelId))
      throw new Error('Evaluation-only model cannot generate chat messages');
    return withPromptCaching(
      createOpenAiCompatibleLanguageModel(
        instance,
        modelId,
        BASE_URL,
        gatewayAttributionHeaders(),
      ),
      'openrouter',
      ['openaiCompatible'],
    );
  },
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
    // The default catalog omits decision models. Fetch both surfaces, using
    // the same credentials and cancellation signal. Either catalog can fail
    // independently without hiding models from the other catalog.
    const decisionsUrl = modelListUrl(instance, BASE_URL);
    decisionsUrl.searchParams.set('output_modalities', 'decisions');
    const results = await Promise.allSettled(
      [modelListUrl(instance, BASE_URL), decisionsUrl].map((url) =>
        fetchJson(
          url,
          {
            ...providerHeaders(instance, 'openai'),
            ...gatewayAttributionHeaders(),
          },
          signal,
        ),
      ),
    );
    signal.throwIfAborted();
    if (results.every((result) => result.status === 'rejected'))
      throw new Error('All OpenRouter model catalogs failed');
    const items = results.flatMap((result) => {
      if (result.status !== 'fulfilled') return [];
      const body = result.value;
      return isRecord(body) && Array.isArray(body.data) ? body.data : [];
    });
    return available([
      ...new Map(
        items
          .flatMap((item) => {
            if (!isRecord(item) || typeof item.id !== 'string') return [];
            const createdAt = parseModelCreatedAt(item.created);
            const architecture = isRecord(item.architecture)
              ? item.architecture
              : undefined;
            const inputModalities = stringArray(architecture?.input_modalities);
            const outputModalities = stringArray(
              architecture?.output_modalities,
            );
            // Extraction-only models share the decisions modality but require a
            // different API and cannot answer evaluation questions.
            const endpoints = stringArray(item.endpoints);
            if (
              outputModalities.includes('decisions') &&
              endpoints.length > 0 &&
              !endpoints.includes('/api/alpha/decisions')
            )
              return [];
            const supportedParameters = stringArray(item.supported_parameters);
            const tools = supportedParameters.includes('tools');
            const reasoning =
              supportedParameters.includes('reasoning') ||
              supportedParameters.includes('reasoning_effort') ||
              supportedParameters.includes('include_reasoning');
            const kind = outputModalities.includes('decisions')
              ? ('evaluation' as const)
              : outputModalities.includes('image') &&
                  !outputModalities.includes('text')
                ? ('image-generation' as const)
                : outputModalities.includes('text')
                  ? ('language' as const)
                  : undefined;
            return [
              {
                modelId: item.id,
                ...(createdAt && { createdAt }),
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
                ...(typeof item.name === 'string' && {
                  displayName: item.name,
                }),
                ...(typeof item.context_length === 'number' && {
                  contextSize: item.context_length,
                }),
              },
            ];
          })
          .map((model) => [model.modelId, model] as const),
      ).values(),
    ]);
  } catch (error) {
    return unavailable('discovery_failed', sanitizedError(error));
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}
