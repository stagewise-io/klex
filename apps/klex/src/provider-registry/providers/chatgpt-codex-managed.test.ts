import '@/ai-sdk-warnings';

import { access } from 'node:fs/promises';

import { generateText } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ProviderContext,
  ProviderCredential,
  ProviderInstance,
} from '../provider-registry';
import {
  CODEX_CLIENT_ID,
  pollDeviceAuthorization,
  refreshCredential,
  startDeviceAuthorization,
} from './chatgpt-codex-device-auth';
import { chatGptCodexSubscriptionProviderDefinition as provider } from './chatgpt-codex-subscription';

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  access: vi.fn(async () => {
    throw new Error('ENOENT');
  }),
  readFile: vi.fn(async () => {
    throw new Error('managed mode must not read local Codex files');
  }),
}));

const signal = new AbortController().signal;

function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode(claims)}.sig`;
}

const accessToken = jwt({
  exp: 2_000_000_000,
  'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' },
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubFetch(...responses: Response[]) {
  const mock = vi.fn(
    async (_input: string | URL | Request, _init?: RequestInit) => {
      const next = responses.shift();
      if (!next) throw new Error('unexpected fetch');
      return next;
    },
  );
  vi.stubGlobal('fetch', mock);
  return mock;
}

function call(mock: ReturnType<typeof stubFetch>, index: number) {
  const [input, init] = mock.mock.calls[index] ?? [];
  return {
    url: String(input),
    method: init?.method,
    headers: new Headers(init?.headers),
    body: init?.body,
  };
}

const credential: ProviderCredential = {
  accessToken: 'old-access',
  refreshToken: 'old-refresh',
  idToken: 'old-id',
  accountId: 'acct-1',
};

const managed: ProviderInstance = {
  id: 'codex',
  type: 'chatgpt-codex-subscription',
  settings: { authMode: 'managed' },
};

function context(
  current: ProviderCredential | undefined,
  refreshed?: ProviderCredential,
): ProviderContext & {
  invalidate: ReturnType<typeof vi.fn>;
} {
  return {
    credential: vi.fn(async () => current),
    invalidate: vi.fn(async () => refreshed),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('Codex device protocol', () => {
  it('requests a user code with the Codex client id', async () => {
    const mock = stubFetch(
      json({ device_auth_id: 'dev-1', user_code: 'ABCD-EFGH', interval: '7' }),
    );
    const result = await startDeviceAuthorization(signal, () => 0);
    expect(result).toEqual({
      ok: true,
      code: 'available',
      value: {
        verificationUri: 'https://auth.openai.com/codex/device',
        userCode: 'ABCD-EFGH',
        expiresAt: new Date(15 * 60_000).toISOString(),
        intervalMs: 7_000,
        handle: { deviceAuthId: 'dev-1', userCode: 'ABCD-EFGH' },
      },
    });
    const request = call(mock, 0);
    expect(request.url).toBe(
      'https://auth.openai.com/api/accounts/deviceauth/usercode',
    );
    expect(request.method).toBe('POST');
    expect(JSON.parse(String(request.body))).toEqual({
      client_id: CODEX_CLIENT_ID,
    });
  });

  it('accepts the usercode alias and defaults the interval', async () => {
    stubFetch(json({ device_auth_id: 'dev-1', usercode: 'CODE' }));
    const result = await startDeviceAuthorization(signal);
    expect(result.ok && result.value.userCode).toBe('CODE');
    expect(result.ok && result.value.intervalMs).toBe(5_000);
  });

  it('reports a disabled device flow', async () => {
    stubFetch(new Response('', { status: 404 }));
    expect(await startDeviceAuthorization(signal)).toMatchObject({
      ok: false,
      code: 'unsupported_operation',
    });
  });

  it.each([403, 404])('treats poll status %i as pending', async (status) => {
    const mock = stubFetch(new Response('', { status }));
    const result = await pollDeviceAuthorization(
      { deviceAuthId: 'dev-1', userCode: 'CODE' },
      signal,
    );
    expect(result).toEqual({
      ok: true,
      code: 'available',
      value: { status: 'pending' },
    });
    const request = call(mock, 0);
    expect(request.url).toBe(
      'https://auth.openai.com/api/accounts/deviceauth/token',
    );
    expect(JSON.parse(String(request.body))).toEqual({
      device_auth_id: 'dev-1',
      user_code: 'CODE',
    });
  });

  it('treats server errors as transient and other rejections as permanent', async () => {
    stubFetch(
      new Response('', { status: 503 }),
      new Response('', { status: 400 }),
    );
    const handle = { deviceAuthId: 'dev-1', userCode: 'CODE' };
    expect(await pollDeviceAuthorization(handle, signal)).toMatchObject({
      code: 'connectivity_failed',
    });
    expect(await pollDeviceAuthorization(handle, signal)).toMatchObject({
      code: 'authentication_required',
    });
  });

  it('exchanges the approved code for credentials', async () => {
    const idToken = jwt({ email: 'user@example.com' });
    const mock = stubFetch(
      json({
        authorization_code: 'auth-code',
        code_challenge: 'challenge',
        code_verifier: 'verifier',
      }),
      json({
        access_token: accessToken,
        refresh_token: 'refresh-1',
        id_token: idToken,
      }),
    );
    const result = await pollDeviceAuthorization(
      { deviceAuthId: 'dev-1', userCode: 'CODE' },
      signal,
    );
    expect(result).toEqual({
      ok: true,
      code: 'available',
      value: {
        status: 'authorized',
        credential: {
          accessToken,
          refreshToken: 'refresh-1',
          idToken,
          expiresAt: new Date(2_000_000_000_000).toISOString(),
          accountId: 'acct-1',
        },
      },
    });
    const exchange = call(mock, 1);
    expect(exchange.url).toBe('https://auth.openai.com/oauth/token');
    expect(exchange.headers.get('content-type')).toBe(
      'application/x-www-form-urlencoded',
    );
    expect(
      Object.fromEntries(new URLSearchParams(String(exchange.body))),
    ).toEqual({
      grant_type: 'authorization_code',
      client_id: CODEX_CLIENT_ID,
      code: 'auth-code',
      redirect_uri: 'https://auth.openai.com/deviceauth/callback',
      code_verifier: 'verifier',
    });
  });

  it('never retries a failed code exchange', async () => {
    stubFetch(
      json({
        authorization_code: 'c',
        code_challenge: 'x',
        code_verifier: 'v',
      }),
      json({ error: 'invalid_grant' }, 400),
    );
    expect(
      await pollDeviceAuthorization(
        { deviceAuthId: 'd', userCode: 'u' },
        signal,
      ),
    ).toMatchObject({ ok: false, code: 'authentication_required' });
  });

  it('rejects an invalid handle without a request', async () => {
    const mock = stubFetch();
    expect(await pollDeviceAuthorization({}, signal)).toMatchObject({
      code: 'internal_error',
    });
    expect(mock).not.toHaveBeenCalled();
  });

  it('refreshes with the JSON body and keeps tokens that did not rotate', async () => {
    const mock = stubFetch(json({ access_token: accessToken }));
    const result = await refreshCredential(credential, signal);
    expect(result).toEqual({
      ok: true,
      code: 'available',
      value: {
        accessToken,
        refreshToken: 'old-refresh',
        idToken: 'old-id',
        expiresAt: new Date(2_000_000_000_000).toISOString(),
        accountId: 'acct-1',
      },
    });
    const request = call(mock, 0);
    expect(request.headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(String(request.body))).toEqual({
      client_id: CODEX_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: 'old-refresh',
    });
  });

  it.each([
    [400, { error: 'refresh_token_expired' }],
    [400, { error: { code: 'refresh_token_reused' } }],
    [400, { code: 'refresh_token_invalidated' }],
    [400, { error: 'invalid_grant' }],
    [401, {}],
  ])(
    'maps refresh status %i %j to authentication_required',
    async (status, body) => {
      stubFetch(json(body, status));
      expect(await refreshCredential(credential, signal)).toMatchObject({
        ok: false,
        code: 'authentication_required',
      });
    },
  );

  it('treats other refresh failures as transient', async () => {
    stubFetch(json({ error: 'server_error' }, 500));
    expect(await refreshCredential(credential, signal)).toMatchObject({
      ok: false,
      code: 'connectivity_failed',
    });
  });

  it('keeps tokens out of error messages', async () => {
    stubFetch(
      json({ error: 'refresh_token_expired', echo: 'old-refresh' }, 400),
    );
    const result = await refreshCredential(credential, signal);
    expect(JSON.stringify(result)).not.toContain('old-refresh');
  });
});

describe('managed Codex provider', () => {
  it('declares device-code authorization only for managed settings', () => {
    expect(provider.authorization?.method).toBe('device-code');
    expect(provider.authorization?.isRequired({ authMode: 'managed' })).toBe(
      true,
    );
    expect(provider.authorization?.isRequired({})).toBe(false);
    expect(provider.authorization?.isRequired({ authMode: 'local-cli' })).toBe(
      false,
    );
  });

  it('passes preflight without a Codex executable', async () => {
    expect(
      await provider.preflightCreate?.({ authMode: 'managed' }, signal),
    ).toEqual({ ok: true, code: 'available', value: undefined });
    expect(access).not.toHaveBeenCalled();
    expect(await provider.preflightCreate?.({}, signal)).toMatchObject({
      ok: false,
      code: 'dependency_missing',
    });
  });

  it('discovers models from the Codex models endpoint', async () => {
    const mock = stubFetch(
      json({
        models: [
          {
            slug: 'gpt-5.6-sol',
            display_name: 'GPT-5.6 Sol',
            visibility: 'list',
            supported_in_api: true,
            context_window: 272000,
            input_modalities: ['text', 'image'],
          },
          { slug: 'hidden', visibility: 'hide', supported_in_api: true },
        ],
      }),
    );
    const result = await provider.discoverModels?.(
      managed,
      signal,
      context(credential),
    );
    expect(result).toEqual({
      ok: true,
      code: 'available',
      value: [
        {
          modelId: 'gpt-5.6-sol',
          kind: 'language',
          displayName: 'GPT-5.6 Sol',
          contextSize: 272000,
          capabilities: { input: { image: {} } },
        },
      ],
    });
    const request = call(mock, 0);
    const url = new URL(request.url);
    expect(`${url.origin}${url.pathname}`).toBe(
      'https://chatgpt.com/backend-api/codex/models',
    );
    expect(url.searchParams.get('client_version')).toMatch(/^\d+\.\d+\.\d+$/);
    expect(request.headers.get('authorization')).toBe('Bearer old-access');
    expect(request.headers.get('chatgpt-account-id')).toBe('acct-1');
  });

  it('reports a missing sign-in instead of reading local files', async () => {
    const mock = stubFetch();
    expect(
      await provider.discoverModels?.(managed, signal, context(undefined)),
    ).toMatchObject({ ok: false, code: 'authentication_required' });
    expect(
      await provider.testConnection(managed, signal, context(undefined)),
    ).toMatchObject({ ok: false, code: 'authentication_required' });
    expect(mock).not.toHaveBeenCalled();
  });

  it('retries a model request once with a refreshed credential after 401', async () => {
    const refreshed = { ...credential, accessToken: 'new-access' };
    const ctx = context(credential, refreshed);
    const mock = stubFetch(
      new Response('', { status: 401 }),
      json({
        id: 'resp',
        model: 'gpt-5.6-sol',
        created_at: 1,
        status: 'completed',
        output: [
          {
            id: 'msg',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'ok', annotations: [] }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    const model = provider.createLanguageModel?.(managed, 'gpt-5.6-sol', ctx);
    if (!model) throw new Error('Missing factory');
    const result = await generateText({ model, prompt: 'hi' });
    expect(result.text).toBe('ok');
    expect(ctx.invalidate).toHaveBeenCalledTimes(1);
    expect(call(mock, 0).headers.get('authorization')).toBe(
      'Bearer old-access',
    );
    expect(call(mock, 1).headers.get('authorization')).toBe(
      'Bearer new-access',
    );
  });
});
