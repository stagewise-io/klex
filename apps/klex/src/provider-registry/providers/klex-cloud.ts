import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenResponses } from '@ai-sdk/open-responses';
import type { LanguageModelV4 } from '@ai-sdk/provider';

import { KLEX_CLOUD_PROTOCOLS, type KlexCloudProtocol } from '@/config';

import type {
  ProviderDefinition,
  ProviderInstance,
  ProviderModelDiscoveryResult,
} from '../provider-registry';
import { resolveAnthropicModelMetadata } from './anthropic';
import { resolveCatalogMetadata } from './model-catalog-helpers';
import { resolveOpenAiModelMetadata } from './openai';
import { withPromptCaching } from './prompt-caching';
import {
  available,
  createOpenAiCompatibleLanguageModel,
  fetchJson,
  gatewayAttributionHeaders,
  isNonLanguageModel,
  isRecord,
  modelListUrl,
  parseModelCreatedAt,
  providerHeaders,
  requiredSetting,
  responsesUrl,
  sanitizedError,
  testDiscoveryConnection,
  unavailable,
} from './shared';

// Every adapter uses this name, so `providerOptions['klex-cloud']` applies to
// all protocols. The Anthropic adapter also reads `providerOptions.anthropic`.
const NAMESPACE = 'klex-cloud';

/**
 * Per-model protocol: the `protocols` setting, then name rules, then
 * Responses. Never derived from discovery, which is lost on restart; a model
 * must not change wire format mid-session.
 */
export function klexCloudProtocol(
  instance: ProviderInstance,
  modelId: string,
): KlexCloudProtocol {
  const configured = isRecord(instance.settings.protocols)
    ? instance.settings.protocols[modelId]
    : undefined;
  if (KLEX_CLOUD_PROTOCOLS.some((protocol) => protocol === configured))
    return configured as KlexCloudProtocol;
  if (/^(?:[^/]+\/)?gpt-audio-/i.test(modelId)) return 'chat-completions';
  if (/^(?:anthropic\/|claude-)/i.test(modelId)) return 'anthropic-messages';
  return 'responses';
}

function resolveModelMetadata(modelId: string) {
  const [, vendor, id = modelId] =
    /^(?:(openai|anthropic)\/)?(.+)$/i.exec(modelId) ?? [];
  if (
    vendor?.toLowerCase() === 'anthropic' ||
    (!vendor && /^claude-/i.test(id))
  )
    return resolveAnthropicModelMetadata(id);
  return (
    (id.includes('/') ? undefined : resolveOpenAiModelMetadata(id)) ??
    resolveCatalogMetadata(modelId, [], modelId)
  );
}

function createLanguageModel(
  instance: ProviderInstance,
  modelId: string,
): LanguageModelV4 {
  const baseUrl = requiredSetting(instance, 'baseUrl');
  const apiKey = requiredSetting(instance, 'apiKey');
  const protocol = klexCloudProtocol(instance, modelId);
  switch (protocol) {
    case 'responses':
      return createOpenResponses({
        name: NAMESPACE,
        url: responsesUrl(baseUrl),
        apiKey,
        headers: gatewayAttributionHeaders(),
      }).languageModel(modelId);
    case 'chat-completions':
      return createOpenAiCompatibleLanguageModel(
        instance,
        modelId,
        undefined,
        gatewayAttributionHeaders(),
      );
    case 'anthropic-messages':
      return withPromptCaching(
        createAnthropic({
          name: `${NAMESPACE}.messages`,
          baseURL: baseUrl,
          authToken: apiKey,
          headers: gatewayAttributionHeaders(),
        }).languageModel(modelId),
        'anthropic',
        [NAMESPACE],
      );
    case 'openai-live':
      throw new Error(
        `Model '${modelId}' uses the reserved 'openai-live' protocol, which this Klex version does not support`,
      );
  }
}

async function discoverModels(
  instance: ProviderInstance,
  signal: AbortSignal,
): Promise<ProviderModelDiscoveryResult> {
  try {
    const body = await fetchJson(
      modelListUrl(instance, requiredSetting(instance, 'baseUrl')),
      {
        ...providerHeaders(instance, 'openai'),
        ...gatewayAttributionHeaders(),
      },
      signal,
    );
    if (!isRecord(body) || !Array.isArray(body.data))
      return unavailable('discovery_failed', 'Invalid Klex Cloud model list');
    // The gateway currently returns only `id`, `object`, `created` and
    // `owned_by`; metadata comes from catalogs and `knownModels`. Models the
    // catalog knows as non-language (e.g. speech-to-speech `gpt-live-*`) are
    // left out: this provider serves language generation only.
    return available(
      body.data.flatMap((item) => {
        if (
          !isRecord(item) ||
          typeof item.id !== 'string' ||
          !item.id ||
          isNonLanguageModel(item.id)
        )
          return [];
        const kind = resolveModelMetadata(item.id)?.kind;
        if (kind && kind !== 'language' && kind !== 'unknown') return [];
        const createdAt = parseModelCreatedAt(item.created);
        return [{ modelId: item.id, ...(createdAt && { createdAt }) }];
      }),
    );
  } catch (error) {
    return unavailable('discovery_failed', sanitizedError(error));
  }
}

export const klexCloudProviderDefinition = {
  type: 'klex-cloud',
  usageGuidance:
    'Use for the Klex Cloud AI gateway with a per-bot sk_sw_ gateway token. One provider serves Responses (default), Chat Completions (gpt-audio-* models) and Anthropic Messages (anthropic/* and claude-* models); the protocols setting overrides the protocol per model. Connectivity checks list models without inference.',
  metadata: {
    displayName: 'Klex Cloud',
    description: 'Managed models routed through the Klex Cloud AI gateway.',
  },
  resolveModelMetadata,
  createLanguageModel,
  discoverModels,
  testConnection: (instance, signal) =>
    testDiscoveryConnection(
      instance,
      requiredSetting(instance, 'baseUrl'),
      () => discoverModels(instance, signal),
    ),
} satisfies ProviderDefinition;
