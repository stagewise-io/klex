import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { APICallError, streamText } from 'ai';

import type {
  ProviderConnectionResult,
  ProviderErrorCode,
  ProviderInstance,
  ProviderModel,
  ProviderOperationResult,
} from '../provider-registry';

export function available<T>(value: T): ProviderOperationResult<T> {
  return { ok: true, code: 'available', value };
}

export function unavailable(
  code: Exclude<ProviderErrorCode, 'available'>,
  message: string,
  remediation?: string,
): ProviderOperationResult<never> {
  return { ok: false, code, message, ...(remediation && { remediation }) };
}

export function createOpenAiCompatibleLanguageModel(
  instance: ProviderInstance,
  modelId: string,
  defaultBaseUrl?: string,
  additionalHeaders: Record<string, string> = {},
  defaultApiKey?: string,
): LanguageModelV4 {
  const baseURL = setting(instance, 'baseUrl') ?? defaultBaseUrl;
  if (!baseURL)
    throw new Error(`Provider '${instance.id}' requires a base URL`);
  return createOpenAICompatible({
    name: instance.type,
    baseURL,
    apiKey: setting(instance, 'apiKey') ?? defaultApiKey,
    headers: {
      ...providerHeaders(instance, 'openai'),
      ...additionalHeaders,
    },
    includeUsage: true,
  }).languageModel(modelId);
}

export async function discoverOpenAiCompatibleModels(
  instance: ProviderInstance,
  defaultBaseUrl: string,
  signal: AbortSignal,
  languageModelsOnly = true,
): Promise<ProviderOperationResult<readonly ProviderModel[]>> {
  try {
    const body = await fetchJson(
      modelListUrl(instance, defaultBaseUrl),
      providerHeaders(instance, 'openai'),
      signal,
    );
    if (!isRecord(body) || !Array.isArray(body.data)) return available([]);
    return available(
      body.data.flatMap((item) =>
        isRecord(item) &&
        typeof item.id === 'string' &&
        (!languageModelsOnly || !isNonLanguageModel(item.id))
          ? [{ modelId: item.id }]
          : [],
      ),
    );
  } catch (error) {
    return unavailable('discovery_failed', sanitizedError(error));
  }
}

export async function testDiscoveryConnection(
  instance: ProviderInstance,
  target: string,
  discover: () => Promise<ProviderOperationResult<readonly ProviderModel[]>>,
): Promise<ProviderOperationResult<ProviderConnectionResult>> {
  const startedAt = Date.now();
  const result = await discover();
  if (!result.ok) return { ...result, code: 'connectivity_failed' };
  return available({
    latencyMs: Math.max(0, Date.now() - startedAt),
    target: new URL(setting(instance, 'baseUrl') ?? target).origin,
  });
}

export async function testModelConnection(
  instance: ProviderInstance,
  target: string,
  createModel: (modelId: string) => LanguageModelV4,
  signal: AbortSignal,
  defaultModelId?: string,
): Promise<ProviderOperationResult<ProviderConnectionResult>> {
  const modelId = connectionModelId(instance) ?? defaultModelId;
  if (!modelId) {
    return unavailable(
      'invalid_configuration',
      'A connectivity-test model ID is required when model discovery is unavailable',
      'Configure testModelId or add at least one known model.',
    );
  }
  const startedAt = Date.now();
  try {
    let streamError: unknown;
    const result = streamText({
      model: createModel(modelId),
      prompt: 'Reply with OK.',
      maxOutputTokens: 1,
      abortSignal: signal,
      onError: ({ error }) => {
        streamError = error;
      },
    });
    try {
      await result.text;
    } catch (error) {
      throw streamError ?? error;
    }
    if (streamError) throw streamError;
    return available({
      latencyMs: Math.max(0, Date.now() - startedAt),
      target: new URL(setting(instance, 'baseUrl') ?? target).origin,
    });
  } catch (error) {
    return unavailable('connectivity_failed', sanitizedError(error));
  }
}

export function setting(
  instance: ProviderInstance,
  key: string,
): string | undefined {
  const value = instance.settings[key];
  return typeof value === 'string' && value ? value : undefined;
}

export function requiredSetting(
  instance: ProviderInstance,
  key: string,
): string {
  const value = setting(instance, key);
  if (!value) throw new Error(`Provider '${instance.id}' requires '${key}'`);
  return value;
}

export function gatewayAttributionHeaders(): Record<string, string> {
  return {
    'HTTP-Referer': 'https://klex.bot',
    'X-Title': 'Klex',
  };
}

export function customHeaders(
  instance: ProviderInstance,
): Record<string, string> {
  return isStringRecord(instance.settings.headers)
    ? { ...instance.settings.headers }
    : {};
}

export function providerHeaders(
  instance: ProviderInstance,
  protocol: 'openai' | 'anthropic',
): Record<string, string> {
  const headers = customHeaders(instance);
  const apiKey = setting(instance, 'apiKey');
  if (protocol === 'anthropic' && apiKey) {
    headers['x-api-key'] ??= apiKey;
    headers['anthropic-version'] ??= '2023-06-01';
  } else if (apiKey) {
    headers.Authorization ??= `Bearer ${apiKey}`;
  }
  return headers;
}

export async function fetchJson(
  url: URL,
  headers: Record<string, string>,
  signal: AbortSignal,
  init: RequestInit = {},
): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    headers,
    signal,
  });
  if (!response.ok)
    throw new Error(`Provider returned HTTP ${response.status}`);
  return response.json() as Promise<unknown>;
}

export function modelListUrl(
  instance: ProviderInstance,
  defaultBaseUrl: string,
): URL {
  const baseUrl = setting(instance, 'baseUrl') ?? defaultBaseUrl;
  return new URL(`${baseUrl.replace(/\/$/, '')}/models`);
}

export function responsesUrl(baseUrl: string): string {
  return /\/responses\/?$/.test(baseUrl)
    ? baseUrl
    : `${baseUrl.replace(/\/$/, '')}/responses`;
}

function connectionModelId(instance: ProviderInstance): string | undefined {
  return (
    setting(instance, 'testModelId') ??
    (instance.knownModels ? Object.keys(instance.knownModels)[0] : undefined)
  );
}

export function isNonLanguageModel(modelId: string): boolean {
  return /(embedding|embed-|tts|whisper|realtime|moderation|dall-e|image)/i.test(
    modelId,
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((item) => typeof item === 'string')
  );
}

export function sanitizedError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError')
    return 'Request timed out';
  if (APICallError.isInstance(error) && error.statusCode !== undefined)
    return `Provider returned HTTP ${error.statusCode}`;
  if (
    error instanceof Error &&
    /^Provider returned HTTP [1-5][0-9]{2}$/.test(error.message)
  )
    return error.message;
  return 'Provider request failed';
}
