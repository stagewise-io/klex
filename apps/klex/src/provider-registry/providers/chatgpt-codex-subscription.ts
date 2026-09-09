import { access, readFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';

import { createOpenResponses } from '@ai-sdk/open-responses';
import type { LanguageModelV4 } from '@ai-sdk/provider';

import type {
  ProviderConnectionResult,
  ProviderDefinition,
  ProviderInstance,
  ProviderModel,
  ProviderOperationResult,
} from '../provider-registry';
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

export const chatGptCodexSubscriptionProviderDefinition: ProviderDefinition = {
  type: 'chatgpt-codex-subscription',
  usageGuidance:
    'Use for Codex models authenticated by a local ChatGPT subscription session. The Codex CLI must be installed and logged in.',
  metadata: {
    displayName: 'ChatGPT Codex Subscription',
    description:
      'Codex model transport authenticated by a local ChatGPT subscription session.',
  },
  resolveModelMetadata: resolveOpenAiModelMetadata,
  preflightCreate: (settings) => preflight(settings),
  createLanguageModel,
  discoverModels,
  testConnection: testCodexConnection,
};

async function testCodexConnection(
  instance: ProviderInstance,
  signal: AbortSignal,
): Promise<ProviderOperationResult<ProviderConnectionResult>> {
  const requestedModel = setting(instance, 'testModelId');
  const modelId =
    requestedModel && requestedModel !== LEGACY_TEST_MODEL_ID
      ? requestedModel
      : ((await loadConfiguredModel(instance)) ?? DEFAULT_TEST_MODEL_ID);
  const { testModelId: _testModelId, ...settings } = instance.settings;
  return testModelConnection(
    { ...instance, settings: { ...settings, testModelId: modelId } },
    BASE_URL,
    (id) => createLanguageModel(instance, id),
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
): Promise<ProviderOperationResult<readonly ProviderModel[]>> {
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
    if (!isRecord(parsed) || !Array.isArray(parsed.models))
      throw new Error('Invalid Codex model catalog');
    const models = parsed.models.flatMap((value): ProviderModel[] => {
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
          ...(Object.keys(capabilities.input).length > 0
            ? { capabilities }
            : {}),
        },
      ];
    });
    return available(models);
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

async function preflight(
  settings: Readonly<Record<string, unknown>>,
): Promise<ProviderOperationResult> {
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
): LanguageModelV4 {
  const baseUrl = setting(instance, 'baseUrl') ?? BASE_URL;
  return createOpenResponses({
    name: 'codex',
    url: responsesUrl(baseUrl),
    fetch: authenticatedFetch(instance),
  }).languageModel(modelId);
}

function authenticatedFetch(instance: ProviderInstance): typeof fetch {
  return async (input, init) => {
    const auth = await loadAuth(instance);
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${auth.accessToken}`);
    if (auth.accountId) headers.set('ChatGPT-Account-Id', auth.accountId);
    headers.set('originator', 'codex_cli_rs');
    headers.set('User-Agent', 'codex_cli_rs');
    return fetch(input, {
      ...init,
      headers,
      body: codexRequestBody(init?.body),
    });
  };
}

function codexRequestBody(body: RequestInit['body']): RequestInit['body'] {
  if (typeof body !== 'string') return body;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!isRecord(parsed)) return body;
    const { max_output_tokens: _maxOutputTokens, ...request } = parsed;
    return JSON.stringify({ ...request, store: false });
  } catch {
    return body;
  }
}

async function loadAuth(
  instance: ProviderInstance,
): Promise<{ accessToken: string; accountId?: string }> {
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
      : jwtStringClaim(
          accessToken,
          'https://api.openai.com/auth.chatgpt_account_id',
        );
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

function jwtExpiration(token: string): number | undefined {
  const value = jwtClaim(token, 'exp');
  return typeof value === 'number' ? value * 1_000 : undefined;
}

function jwtStringClaim(token: string, claim: string): string | undefined {
  const value = jwtClaim(token, claim);
  return typeof value === 'string' ? value : undefined;
}

function jwtClaim(token: string, claim: string): unknown {
  try {
    const payload = token.split('.')[1];
    if (!payload) return undefined;
    const parsed = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as unknown;
    return isRecord(parsed) ? parsed[claim] : undefined;
  } catch {
    return undefined;
  }
}
