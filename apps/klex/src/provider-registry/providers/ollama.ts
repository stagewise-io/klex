import { interpolateEnvironment } from '@/config';

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
  sanitizedError,
  setting,
  testDiscoveryConnection,
  unavailable,
} from './shared';

const BASE_URL = 'http://127.0.0.1:11434/v1';

export const ollamaProviderDefinition: ProviderDefinition = {
  type: 'ollama',
  usageGuidance:
    'Use for models served by a local Ollama daemon. Start Ollama before adding the provider so its availability can be verified.',
  metadata: {
    displayName: 'Ollama',
    description: 'Models served by a local Ollama daemon.',
    documentationUrl: 'https://ollama.com/',
  },
  resolveModelMetadata: (modelId) =>
    resolveCatalogMetadata(modelId, [], modelId),
  preflightCreate: (settings, signal) => preflight(settings, signal),
  createLanguageModel: (instance, modelId) =>
    createOpenAiCompatibleLanguageModel(
      {
        ...instance,
        settings: {
          ...instance.settings,
          baseUrl: openAiBaseUrl(setting(instance, 'baseUrl') ?? BASE_URL),
        },
      },
      modelId,
      undefined,
      {},
      'ollama',
    ),
  discoverModels,
  testConnection: (instance, signal) =>
    testDiscoveryConnection(instance, BASE_URL, () =>
      discoverModels(instance, signal),
    ),
};

async function preflight(
  settings: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
): Promise<ProviderOperationResult> {
  const instance: ProviderInstance = {
    id: 'preflight',
    type: 'ollama',
    settings: interpolateEnvironment(settings, process.env),
  };
  const tested = await testDiscoveryConnection(
    instance,
    setting(instance, 'baseUrl') ?? BASE_URL,
    () => discoverModels(instance, signal),
  );
  return tested.ok
    ? available(undefined)
    : {
        ...tested,
        message: 'Ollama is not reachable',
        remediation: 'Start Ollama and verify the configured base URL.',
      };
}

async function discoverModels(
  instance: ProviderInstance,
  signal: AbortSignal,
): Promise<ProviderOperationResult<readonly ProviderModel[]>> {
  try {
    const root = ollamaRootUrl(setting(instance, 'baseUrl') ?? BASE_URL);
    const body = await fetchJson(new URL('api/tags', root), {}, signal);
    if (!isRecord(body) || !Array.isArray(body.models)) return available([]);
    const ids = body.models.flatMap((item) =>
      isRecord(item) && typeof item.name === 'string' ? [item.name] : [],
    );
    const models: ProviderModel[] = [];
    for (let index = 0; index < ids.length; index += 4) {
      const details = await Promise.all(
        ids.slice(index, index + 4).map(async (modelId) => {
          try {
            const metadata = await fetchJson(
              new URL('api/show', root),
              { 'Content-Type': 'application/json' },
              signal,
              { method: 'POST', body: JSON.stringify({ model: modelId }) },
            );
            if (isRecord(metadata) && Array.isArray(metadata.capabilities)) {
              const capabilities = metadata.capabilities.filter(
                (item): item is string => typeof item === 'string',
              );
              return {
                modelId,
                kind: capabilities.includes('completion')
                  ? ('language' as const)
                  : capabilities.includes('embedding')
                    ? ('embedding' as const)
                    : ('unknown' as const),
                ...((capabilities.includes('vision') ||
                  capabilities.includes('tools') ||
                  capabilities.includes('thinking')) && {
                  capabilities: {
                    ...(capabilities.includes('vision') && {
                      input: { image: {} },
                    }),
                    ...(capabilities.includes('tools') && { tools: true }),
                    ...(capabilities.includes('thinking') && {
                      reasoning: true,
                    }),
                  },
                }),
              };
            }
          } catch (error) {
            if (signal.aborted) throw error;
            // Older Ollama servers may not support /api/show.
          }
          return { modelId };
        }),
      );
      for (const detail of details) if (detail) models.push(detail);
    }
    return available(models);
  } catch (error) {
    return unavailable('discovery_failed', sanitizedError(error));
  }
}

function ollamaRootUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.pathname = url.pathname.replace(/\/v1\/?$/, '/') || '/';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function openAiBaseUrl(baseUrl: string): string {
  return new URL('v1', ollamaRootUrl(baseUrl)).toString().replace(/\/$/, '');
}
