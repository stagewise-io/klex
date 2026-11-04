import { access, readFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';

import { createOpenResponses } from '@ai-sdk/open-responses';
import type { LanguageModelV4 } from '@ai-sdk/provider';

import type {
  ProviderAuthorization,
  ProviderConnectionResult,
  ProviderContext,
  ProviderDefinition,
  ProviderInstance,
  ProviderModel,
  ProviderOperationResult,
  ProviderSettings,
} from '../provider-registry';
import {
  codexAccountId,
  jwtExpiration,
  pollDeviceAuthorization,
  refreshCredential,
  startDeviceAuthorization,
} from './chatgpt-codex-device-auth';
import { resolveOpenAiModelMetadata } from './openai';
import {
  available,
  isRecord,
  responsesUrl,
  sanitizedError,
  setting,
  testModelConnection,
  unavailable,
} from './shared';

const BASE_URL = 'https://chatgpt.com/backend-api/codex/responses';
const LEGACY_TEST_MODEL_ID = 'gpt-5-codex';
const DEFAULT_TEST_MODEL_ID = 'gpt-5.6-sol';
/**
 * Sent as `client_version` on model-catalog requests, as the Codex CLI does.
 * The service omits every model whose minimum client version is newer than
 * this value: 0.130.0 returned only a hidden model, 0.166.0 returned the full
 * catalog. Keep it at a released `@openai/codex` npm version and raise it when
 * managed discovery returns fewer models than the Codex CLI.
 */
const CODEX_CLIENT_VERSION = '0.166.0';

const SIGN_IN_REQUIRED = 'ChatGPT sign-in is required for this provider';

function isManaged(settings: ProviderSettings): boolean {
  return settings.authMode === 'managed';
}

const authorization: ProviderAuthorization = {
  method: 'device-code',
  isRequired: isManaged,
  // Tokens are sent to baseUrl; a different endpoint needs a new sign-in.
  credentialScope: (settings) => JSON.stringify(settings.baseUrl ?? BASE_URL),
  start: (_instance, signal) => startDeviceAuthorization(signal),
  poll: (_instance, handle, signal) => pollDeviceAuthorization(handle, signal),
  refresh: (_instance, credential, signal) =>
    refreshCredential(credential, signal),
};

export const chatGptCodexSubscriptionProviderDefinition: ProviderDefinition = {
  type: 'chatgpt-codex-subscription',
  usageGuidance:
    'Use for Codex models authenticated by a ChatGPT subscription. authMode "local-cli" (default) reads the session of a locally installed and logged-in Codex CLI. authMode "managed" needs no Codex CLI: Klex signs in through the ChatGPT device-code flow and stores and refreshes the credentials itself.',
  metadata: {
    displayName: 'ChatGPT Codex Subscription',
    description:
      'Codex model transport authenticated by a ChatGPT subscription session, either from a local Codex CLI or signed in by Klex.',
  },
  resolveModelMetadata: resolveOpenAiModelMetadata,
  preflightCreate: (settings) => preflight(settings),
  authorization,
  createLanguageModel,
  discoverModels,
  testConnection: testCodexConnection,
};

async function testCodexConnection(
  instance: ProviderInstance,
  signal: AbortSignal,
  context?: ProviderContext,
): Promise<ProviderOperationResult<ProviderConnectionResult>> {
  if (isManaged(instance.settings) && !(await context?.credential()))
    return unavailable(
      'authentication_required',
      SIGN_IN_REQUIRED,
      'Sign in with ChatGPT first.',
    );
  const requestedModel = setting(instance, 'testModelId');
  const modelId =
    requestedModel && requestedModel !== LEGACY_TEST_MODEL_ID
      ? requestedModel
      : ((isManaged(instance.settings)
          ? undefined
          : await loadConfiguredModel(instance)) ?? DEFAULT_TEST_MODEL_ID);
  const { testModelId: _testModelId, ...settings } = instance.settings;
  return testModelConnection(
    { ...instance, settings: { ...settings, testModelId: modelId } },
    BASE_URL,
    (id) => createLanguageModel(instance, id, context),
    signal,
  );
}

async function loadConfiguredModel(
  instance: ProviderInstance,
): Promise<string | undefined> {
  const configFile = codexFile(instance, 'config.toml');
  if (!configFile) return undefined;
  try {
    const config = await readFile(configFile, 'utf8');
    const match = /^\s*model\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))/m.exec(
      config,
    );
    return match?.[1] ?? match?.[2] ?? match?.[3];
  } catch {
    return undefined;
  }
}

async function discoverModels(
  instance: ProviderInstance,
  signal: AbortSignal,
  context?: ProviderContext,
): Promise<ProviderOperationResult<readonly ProviderModel[]>> {
  if (isManaged(instance.settings))
    return discoverManagedModels(instance, signal, context);
  const cacheFile = codexFile(instance, 'models_cache.json');
  if (!cacheFile)
    return unavailable(
      'discovery_failed',
      'Cannot determine the Codex model catalog location',
      'Configure authFile or ensure HOME points to the Codex CLI data directory.',
    );
  try {
    signal.throwIfAborted();
    const parsed = JSON.parse(
      await readFile(cacheFile, { encoding: 'utf8', signal }),
    ) as unknown;
    return available(parseModelCatalog(parsed));
  } catch (error) {
    return unavailable(
      'discovery_failed',
      signal.aborted
        ? sanitizedError(error)
        : 'Codex model catalog is unavailable or invalid',
      'Run the Codex CLI once to refresh its model catalog, then try again.',
    );
  }
}

async function discoverManagedModels(
  instance: ProviderInstance,
  signal: AbortSignal,
  context: ProviderContext | undefined,
): Promise<ProviderOperationResult<readonly ProviderModel[]>> {
  const url = new URL(modelsUrl(setting(instance, 'baseUrl') ?? BASE_URL));
  url.searchParams.set('client_version', CODEX_CLIENT_VERSION);
  let response: Response;
  try {
    response = await managedFetch(context)(url, { method: 'GET', signal });
  } catch (error) {
    if (error instanceof Error && error.message === SIGN_IN_REQUIRED)
      return unavailable(
        'authentication_required',
        SIGN_IN_REQUIRED,
        'Sign in with ChatGPT first.',
      );
    return unavailable('discovery_failed', sanitizedError(error));
  }
  if (response.status === 401 || response.status === 403)
    return unavailable(
      'authentication_required',
      'ChatGPT rejected the stored sign-in',
      'Sign in with ChatGPT again.',
    );
  if (!response.ok)
    return unavailable(
      'discovery_failed',
      `Provider returned HTTP ${response.status}`,
    );
  try {
    return available(parseModelCatalog(await response.json()));
  } catch {
    return unavailable('discovery_failed', 'Codex model catalog is invalid');
  }
}

/** `https://…/codex/responses` → `https://…/codex/models`. */
function modelsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, '').replace(/\/responses$/, '')}/models`;
}

/** Parses the `/codex/models` response, which is also the CLI cache shape. */
function parseModelCatalog(parsed: unknown): ProviderModel[] {
  if (!isRecord(parsed) || !Array.isArray(parsed.models))
    throw new Error('Invalid Codex model catalog');
  return parsed.models.flatMap((value): ProviderModel[] => {
    if (
      !isRecord(value) ||
      typeof value.slug !== 'string' ||
      !value.slug ||
      value.visibility !== 'list' ||
      value.supported_in_api !== true
    )
      return [];
    const inputModalities = Array.isArray(value.input_modalities)
      ? value.input_modalities
      : [];
    const capabilities = {
      input: {
        ...(inputModalities.includes('image') && { image: {} }),
        ...(inputModalities.includes('audio') && { audio: {} }),
      },
    };
    return [
      {
        modelId: value.slug,
        kind: 'language',
        ...(typeof value.display_name === 'string' && value.display_name
          ? { displayName: value.display_name }
          : {}),
        ...(typeof value.context_window === 'number' &&
        Number.isFinite(value.context_window) &&
        value.context_window > 0
          ? { contextSize: value.context_window }
          : {}),
        ...(Object.keys(capabilities.input).length > 0 ? { capabilities } : {}),
      },
    ];
  });
}

async function preflight(
  settings: Readonly<Record<string, unknown>>,
): Promise<ProviderOperationResult> {
  // Managed instances are created signed out; the sign-in follows creation.
  if (isManaged(settings)) return available(undefined);
  const instance: ProviderInstance = {
    id: 'preflight',
    type: 'chatgpt-codex-subscription',
    settings,
  };
  const executable = setting(instance, 'codexExecutable') ?? 'codex';
  if (!(await findExecutable(executable))) {
    return unavailable(
      'dependency_missing',
      'Codex CLI is not installed',
      'Install the Codex CLI and run codex login.',
    );
  }
  try {
    const auth = await loadAuth(instance);
    const expiresAt = jwtExpiration(auth.accessToken);
    if (expiresAt !== undefined && expiresAt <= Date.now()) {
      return unavailable(
        'authentication_required',
        'The Codex login session has expired',
        'Run codex login again.',
      );
    }
    return available(undefined);
  } catch (error) {
    return unavailable(
      'authentication_required',
      sanitizedError(error),
      'Run codex login and verify the configured auth file.',
    );
  }
}

function createLanguageModel(
  instance: ProviderInstance,
  modelId: string,
  context?: ProviderContext,
): LanguageModelV4 {
  const baseUrl = setting(instance, 'baseUrl') ?? BASE_URL;
  return createOpenResponses({
    name: 'codex',
    url: responsesUrl(baseUrl),
    fetch: responsesFetch(
      isManaged(instance.settings)
        ? managedFetch(context)
        : localCliFetch(instance),
    ),
  }).languageModel(modelId);
}

interface CodexAuth {
  accessToken: string;
  accountId?: string;
}

function withCodexHeaders(
  init: RequestInit | undefined,
  auth: CodexAuth,
): Headers {
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${auth.accessToken}`);
  if (auth.accountId) headers.set('ChatGPT-Account-Id', auth.accountId);
  headers.set('originator', 'codex_cli_rs');
  headers.set('User-Agent', 'codex_cli_rs');
  return headers;
}

function localCliFetch(instance: ProviderInstance): typeof fetch {
  return async (input, init) =>
    fetch(input, {
      ...init,
      headers: withCodexHeaders(init, await loadAuth(instance)),
    });
}

/**
 * Uses registry-owned credentials only; never falls back to a local Codex
 * session. Retries once with a forced refresh after a 401.
 */
function managedFetch(context: ProviderContext | undefined): typeof fetch {
  return async (input, init) => {
    const credential = await context?.credential();
    if (!credential) throw new Error(SIGN_IN_REQUIRED);
    const response = await fetch(input, {
      ...init,
      headers: withCodexHeaders(init, credential),
    });
    const replayable =
      init?.body === undefined ||
      init.body === null ||
      typeof init.body === 'string';
    if (response.status !== 401 || !replayable || init?.signal?.aborted)
      return response;
    const refreshed = await context?.invalidate();
    if (!refreshed || refreshed.accessToken === credential.accessToken)
      return response;
    await response.body?.cancel().catch(() => {});
    return fetch(input, {
      ...init,
      headers: withCodexHeaders(init, refreshed),
    });
  };
}

function responsesFetch(authorizedFetch: typeof fetch): typeof fetch {
  return async (input, init) => {
    const request = codexRequestBody(init?.body);
    const response = await authorizedFetch(input, {
      ...init,
      body: request.body,
    });
    return request.streaming ? response : collectCodexResponse(response);
  };
}

function codexRequestBody(body: RequestInit['body']): {
  body: RequestInit['body'];
  streaming: boolean;
} {
  if (typeof body !== 'string') return { body, streaming: true };
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!isRecord(parsed)) return { body, streaming: true };
    // The subscription endpoint is streaming-only and does not accept sampling
    // controls. Keep structured-output settings intact: Codex supports schemas.
    const {
      max_output_tokens: _maxOutputTokens,
      temperature: _temperature,
      top_p: _topP,
      presence_penalty: _presencePenalty,
      frequency_penalty: _frequencyPenalty,
      ...request
    } = parsed;
    return {
      body: JSON.stringify({ ...request, store: false, stream: true }),
      streaming: parsed.stream === true,
    };
  } catch {
    return { body, streaming: true };
  }
}

/** Adapt only non-streaming SDK calls; the SDK still owns response decoding. */
async function collectCodexResponse(response: Response): Promise<Response> {
  const contentType = response.headers.get('content-type');
  // Every Codex request above explicitly asks for SSE, but successful responses
  // can omit Content-Type. Do not pass those streams to the SDK's JSON decoder.
  // Preserve explicitly non-SSE responses and HTTP errors for SDK handling.
  if (
    !response.ok ||
    (contentType !== null && !contentType.includes('text/event-stream'))
  )
    return response;
  if (!response.body)
    throw new Error('Codex returned an empty response stream');
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  const items = new Map<number, unknown>();
  let pending = '';
  const jsonResponse = (body: Record<string, unknown>) => {
    const headers = new Headers(response.headers);
    headers.set('content-type', 'application/json');
    headers.delete('content-length');
    headers.delete('content-encoding');
    headers.delete('transfer-encoding');
    return new Response(JSON.stringify(body), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
  const consumeEvent = (frame: string): Response | undefined => {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data || data === '[DONE]') return;
    const event: unknown = JSON.parse(data);
    if (!isRecord(event)) return;
    if (
      event.type === 'response.output_item.done' &&
      Number.isInteger(event.output_index) &&
      typeof event.output_index === 'number' &&
      event.output_index >= 0 &&
      isRecord(event.item)
    )
      items.set(event.output_index, event.item);
    if (event.type === 'error')
      return jsonResponse({
        error: isRecord(event.error)
          ? event.error
          : { message: 'Codex returned a stream error' },
      });
    if (
      (event.type === 'response.completed' ||
        event.type === 'response.incomplete' ||
        event.type === 'response.failed') &&
      isRecord(event.response)
    ) {
      const final = event.response;
      // Some Codex terminal events carry only metadata/usage. Completed item
      // events are authoritative; never manufacture output from partial deltas.
      const output =
        Array.isArray(final.output) && final.output.length > 0
          ? final.output
          : [...items].sort(([a], [b]) => a - b).map(([, item]) => item);
      return jsonResponse({ ...final, output });
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += value;
      let separator = /\r?\n\r?\n/.exec(pending);
      while (separator) {
        const result = consumeEvent(pending.slice(0, separator.index));
        pending = pending.slice(separator.index + separator[0].length);
        if (result) return result;
        separator = /\r?\n\r?\n/.exec(pending);
      }
    }
    const result = consumeEvent(pending);
    if (result) return result;
    throw new Error('Codex response stream ended before completion');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function loadAuth(instance: ProviderInstance): Promise<CodexAuth> {
  const authFile =
    setting(instance, 'authFile') ?? codexFile(instance, 'auth.json');
  if (!authFile)
    throw new Error('Cannot determine the Codex auth file location');
  const parsed = JSON.parse(await readFile(authFile, 'utf8')) as unknown;
  if (!isRecord(parsed) || !isRecord(parsed.tokens))
    throw new Error('Codex auth file is invalid');
  const accessToken = parsed.tokens.access_token;
  if (typeof accessToken !== 'string' || !accessToken)
    throw new Error('Codex login session is missing');
  const accountId =
    typeof parsed.tokens.account_id === 'string'
      ? parsed.tokens.account_id
      : codexAccountId(accessToken);
  return { accessToken, ...(accountId && { accountId }) };
}

function codexFile(
  instance: ProviderInstance,
  fileName: string,
): string | undefined {
  const authFile = setting(instance, 'authFile');
  if (authFile) return join(dirname(authFile), fileName);
  const home =
    process.env.CODEX_HOME ??
    (process.env.HOME ? join(process.env.HOME, '.codex') : undefined);
  return home ? join(home, fileName) : undefined;
}

async function findExecutable(name: string): Promise<string | undefined> {
  if (name.includes('/') || name.includes('\\')) {
    try {
      await access(name);
      return name;
    } catch {
      return undefined;
    }
  }
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue searching PATH.
    }
  }
  return undefined;
}
