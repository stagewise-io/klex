import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogle } from '@ai-sdk/google';
import { createOpenResponses } from '@ai-sdk/open-responses';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModelV4, ProviderV4 } from '@ai-sdk/provider';
import type { ModuleLogger, RootLogger } from '@stagewise/logger';
import type { Config, ModelId, ResolvedModelConfig } from '@/config';

interface CachedProvider {
  provider: ProviderV4;
  configSignature: string;
}

export interface ModelProvider {
  start(): Promise<void>;
  close(): Promise<void>;
  get(modelId: ModelId): Promise<LanguageModelV4>;
}

export interface ModelProviderDependencies {
  logging: RootLogger;
  config: Config;
}

class ModelProviderModule implements ModelProvider {
  private readonly providerCache = new Map<string, CachedProvider>();
  private started = false;

  constructor(
    private readonly deps: {
      logger: ModuleLogger;
      config: Config;
    },
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.deps.logger.info('ModelProvider started');
  }

  async close(): Promise<void> {
    if (!this.started) return;
    this.providerCache.clear();
    this.started = false;
    this.deps.logger.info('ModelProvider stopped');
  }

  async get(modelId: ModelId): Promise<LanguageModelV4> {
    const resolved = this.deps.config.resolveModel(modelId);

    const cacheKey = resolved.isPreset
      ? resolved.providerId
      : `${resolved.providerId}:${resolved.endpointId}`;

    const configSignature = JSON.stringify({
      url: resolved.endpoint.url,
      format: resolved.endpoint.format,
      auth: resolved.endpoint.auth,
    });

    const cached = this.providerCache.get(cacheKey);
    if (cached && cached.configSignature === configSignature) {
      return cached.provider.languageModel(resolved.modelId);
    }

    const provider = this.instantiateProvider(
      resolved.isPreset ? resolved.providerId : resolved.endpointId,
      resolved,
    );

    this.providerCache.set(cacheKey, { provider, configSignature });

    if (cached) {
      this.deps.logger.info(
        { cacheKey },
        'ModelProvider re-instantiated provider (config changed)',
      );
    } else {
      this.deps.logger.info(
        { cacheKey },
        'ModelProvider instantiated provider',
      );
    }

    return provider.languageModel(resolved.modelId);
  }

  private instantiateProvider(
    nameId: string,
    resolved: ResolvedModelConfig,
  ): ProviderV4 {
    const endpoint = resolved.endpoint;
    const apiKey = endpoint.auth?.apiKey ?? '';

    switch (endpoint.format) {
      case 'openai':
        return createOpenAI({ baseURL: endpoint.url, apiKey });
      case 'anthropic':
        return createAnthropic({ baseURL: endpoint.url, apiKey });
      case 'google':
        return createGoogle({ baseURL: endpoint.url, apiKey });
      case 'chat-completions':
        return createOpenAICompatible({
          name: nameId,
          baseURL: endpoint.url,
          apiKey,
        });
      case 'open-responses':
        return createOpenResponses({
          name: nameId,
          url: endpoint.url,
          apiKey,
        });
      case 'messages':
        return createAnthropic({ baseURL: endpoint.url, apiKey });
      default:
        throw new Error(
          `Provider instantiation not implemented for format "${endpoint.format}"`,
        );
    }
  }
}

export function createModelProvider(
  deps: ModelProviderDependencies,
): ModelProvider {
  return new ModelProviderModule({
    logger: deps.logging.child({
      name: 'model-provider',
      bindings: { module: 'model-provider' },
    }),
    config: deps.config,
  });
}
