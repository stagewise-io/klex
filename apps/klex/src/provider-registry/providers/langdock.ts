import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogle } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';

import { mergeProviderModels } from '../model-metadata';
import type {
  ProviderContext,
  ProviderDefinition,
  ProviderInstance,
  ProviderModel,
  ProviderModelDiscoveryResult,
} from '../provider-registry';
import { withRemoteInputMapping } from '../remote-input';
import { resolveAnthropicModelMetadata } from './anthropic';
import { resolveGoogleModelMetadata } from './google-gemini';
import { resolveCatalogMetadata } from './model-catalog-helpers';
import { resolveOpenAiModelMetadata } from './openai';
import { withPromptCaching } from './prompt-caching';
import {
  available,
  customHeaders,
  fetchJson,
  gatewayAttributionHeaders,
  isNonLanguageModel,
  isRecord,
  parseModelCreatedAt,
  requiredSetting,
  setting,
  testDiscoveryConnection,
  unavailable,
} from './shared';

const BASE_URL = 'https://api.langdock.com';
const protocols = ['openai', 'anthropic', 'google'] as const;
type Protocol = (typeof protocols)[number];
type Route = { protocol: Protocol; upstreamId: string };

// Object identity ties routing to the exact discovery snapshot retained by the
// registry (including partial refreshes). No credentials, global instance map,
// persisted metadata, or stale configuration routes are retained here.
const routes = new WeakMap<ProviderModel, Route>();

function discoveredRoute(model: ProviderModel): Route {
  const route = routes.get(model);
  if (!route) throw new Error('Missing Langdock discovery route');
  return route;
}

function baseUrl(instance: ProviderInstance, protocol: Protocol): string {
  const root = (setting(instance, 'baseUrl') ?? BASE_URL)
    .replace(/\/+$/, '')
    .replace(/\/(?:openai|anthropic|google)\/(?:eu|us)\/(?:v1|v1beta)$/, '');
  return `${root}/${protocol}/${setting(instance, 'region') ?? 'eu'}/${protocol === 'google' ? 'v1beta' : 'v1'}`;
}

function headers(instance: ProviderInstance): Record<string, string> {
  const result = new Headers({
    ...customHeaders(instance),
    ...gatewayAttributionHeaders(),
  });
  result.set('Authorization', `Bearer ${requiredSetting(instance, 'apiKey')}`);
  return Object.fromEntries(result);
}

function inferRoute(modelId: string): Route {
  const prefix = /^(openai|anthropic|google)\/(.+)$/i.exec(modelId);
  if (prefix?.[1] && prefix[2])
    return {
      protocol: prefix[1].toLowerCase() as Protocol,
      upstreamId: prefix[2],
    };
  const protocol =
    /^(?:models\/)?(?:(?:eu|us|apac)\.)?(?:anthropic\.)?claude-/i.test(modelId)
      ? 'anthropic'
      : /^(?:models\/)?gemini-/i.test(modelId)
        ? 'google'
        : 'openai';
  return { protocol, upstreamId: modelId };
}

function metadata(modelId: string) {
  const route = inferRoute(modelId);
  const id = route.upstreamId
    .replace(/^models\//i, '')
    .replace(/^(?:(?:eu|us|apac)\.)?anthropic\./i, '');
  if (route.protocol === 'anthropic')
    return resolveAnthropicModelMetadata(id.replace(/-default$/, ''));
  if (route.protocol === 'google') return resolveGoogleModelMetadata(id);
  return resolveOpenAiModelMetadata(id) ?? resolveCatalogMetadata(id, [], id);
}

export const langdockProviderDefinition = {
  type: 'langdock',
  usageGuidance:
    'Route models through Langdock using a Bearer API key. Region defaults to eu. Optional openai/, anthropic/, and google/ model prefixes select a protocol explicitly; discovery records routes for custom model IDs. Connectivity checks list models without inference.',
  metadata: {
    displayName: 'Langdock',
    description: 'Models routed through the Langdock Completion API.',
    documentationUrl:
      'https://docs.langdock.com/en/developer/completion-api/completion-overview',
  },
  resolveModelMetadata: metadata,
  createLanguageModel: (
    instance: ProviderInstance,
    modelId: string,
    context?: ProviderContext,
  ) => {
    const discovered = context?.discoveredModel?.(modelId);
    const { protocol, upstreamId } =
      (discovered && routes.get(discovered)) || inferRoute(modelId);
    const options = {
      baseURL: baseUrl(instance, protocol),
      apiKey: requiredSetting(instance, 'apiKey'),
      headers: headers(instance),
    };
    if (protocol === 'anthropic')
      return withPromptCaching(
        createAnthropic(options).languageModel(upstreamId),
        'anthropic',
        ['langdock'],
      );
    if (protocol === 'google')
      return withRemoteInputMapping(
        createGoogle(options).languageModel(
          upstreamId.replace(/^models\//, ''),
        ),
        'google-generative',
      );
    return createOpenAI(options).chat(upstreamId);
  },
  discoverModels,
  testConnection: (instance, signal) =>
    testDiscoveryConnection(instance, BASE_URL, () =>
      discoverModels(instance, signal),
    ),
} satisfies ProviderDefinition;

async function discoverModels(
  instance: ProviderInstance,
  signal: AbortSignal,
  context?: ProviderContext,
): Promise<ProviderModelDiscoveryResult> {
  const results = await Promise.allSettled(
    protocols.map((protocol) => discoverProtocol(instance, protocol, signal)),
  );
  const successful = results.filter((result) => result.status === 'fulfilled');
  if (!successful.length)
    return unavailable(
      'discovery_failed',
      'Langdock model discovery failed on all protocols.',
    );
  const models = new Map<string, ProviderModel>();
  const collisions = new Map<string, ProviderModel[]>();
  const partial = successful.length !== protocols.length;
  for (const result of successful) {
    for (const model of result.value) {
      const cached = partial
        ? context?.discoveredModel?.(model.modelId)
        : undefined;
      const previous =
        models.get(model.modelId) ??
        (cached && routes.has(cached) ? cached : undefined);
      if (!previous) models.set(model.modelId, model);
      else if (
        discoveredRoute(previous).protocol !== discoveredRoute(model).protocol
      ) {
        const group = collisions.get(model.modelId) ?? [previous];
        if (
          !group.some(
            (entry) =>
              discoveredRoute(entry).protocol ===
              discoveredRoute(model).protocol,
          )
        )
          group.push(model);
        models.set(model.modelId, previous);
        collisions.set(model.modelId, group);
      } else models.set(model.modelId, model);
    }
  }
  // Reserve all literal upstream IDs before allocating aliases, including IDs
  // which already contain a protocol prefix. Never overwrite a literal model.
  for (const group of collisions.values()) {
    for (const collision of group) {
      const route = discoveredRoute(collision);
      let modelId = `${route.protocol}/${route.upstreamId}`;
      while (models.has(modelId)) modelId = `${route.protocol}/${modelId}`;
      const alias = { ...collision, modelId };
      routes.set(alias, route);
      models.set(modelId, alias);
    }
  }
  return {
    ...available([...models.values()]),
    partial,
  };
}

async function discoverProtocol(
  instance: ProviderInstance,
  protocol: Protocol,
  signal: AbortSignal,
): Promise<ProviderModel[]> {
  const models: ProviderModel[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const url = new URL(`${baseUrl(instance, protocol)}/models`);
    if (cursor)
      url.searchParams.set(
        protocol === 'google' ? 'pageToken' : 'after_id',
        cursor,
      );
    const body = await fetchJson(url, headers(instance), signal);
    if (!isRecord(body)) throw new Error('Invalid Langdock model list');
    const items = protocol === 'google' ? body.models : body.data;
    if (!Array.isArray(items)) throw new Error('Invalid Langdock model list');
    for (const item of items) {
      if (!isRecord(item)) continue;
      const id = protocol === 'google' ? item.name : item.id;
      if (typeof id !== 'string' || !id) continue;
      if (protocol === 'openai' && isNonLanguageModel(id)) continue;
      const upstreamId =
        protocol === 'google' ? id.replace(/^models\//, '') : id;
      const displayName =
        protocol === 'google' ? item.displayName : item.display_name;
      const contextSize =
        protocol === 'google' ? item.inputTokenLimit : item.max_input_tokens;
      const createdAt = parseModelCreatedAt(item.created_at ?? item.created);
      const methods = Array.isArray(item.supportedGenerationMethods)
        ? item.supportedGenerationMethods
        : [];
      const capabilities = isRecord(item.capabilities)
        ? item.capabilities
        : undefined;
      const supports = (value: unknown) =>
        typeof value === 'boolean'
          ? value
          : isRecord(value) && typeof value.supported === 'boolean'
            ? value.supported
            : undefined;
      const image = supports(capabilities?.image_input);
      const reasoning = supports(capabilities?.thinking);
      const discovered: ProviderModel = {
        modelId: upstreamId,
        ...(protocol === 'anthropic' && { kind: 'language' as const }),
        ...(methods.includes('generateContent')
          ? { kind: 'language' as const }
          : methods.includes('embedContent')
            ? { kind: 'embedding' as const }
            : {}),
        ...(typeof displayName === 'string' && { displayName }),
        ...(typeof contextSize === 'number' &&
          contextSize > 0 && { contextSize }),
        ...(createdAt && { createdAt }),
        ...(capabilities && {
          capabilities: {
            ...(image === true && {
              input: {
                image: {
                  mediaTypes: [
                    'image/jpeg',
                    'image/png',
                    'image/webp',
                    'image/gif',
                  ],
                },
              },
            }),
            ...(reasoning !== undefined && { reasoning }),
          },
        }),
        provenance: [{ source: 'discovered' }],
      };
      const model =
        mergeProviderModels(
          { modelId: upstreamId, ...metadata(`${protocol}/${upstreamId}`) },
          discovered,
        ) ?? discovered;
      routes.set(model, { protocol, upstreamId });
      models.push(model);
    }
    cursor =
      protocol === 'google' && typeof body.nextPageToken === 'string'
        ? body.nextPageToken
        : body.has_more === true && typeof body.last_id === 'string'
          ? body.last_id
          : undefined;
    if (body.has_more === true && !cursor)
      throw new Error('Missing Langdock pagination cursor');
    if (cursor && seen.has(cursor))
      throw new Error('Repeated Langdock pagination cursor');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return models;
}
