import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RootLogger } from '@stagewise/logger';

import {
  CONFIG_FILE_NAME,
  CONFIG_STORE_DEFINITION,
  createConfig,
} from '@/config';
import { completeV4StoredConfig } from '@/config/config.test-fixtures';
import { createLocalData } from '@/local-data';
import { KLEX_VERSION } from '@/release';

import {
  PROVIDER_CREDENTIALS_STORE_DEFINITION,
  ProviderCredentialStore,
} from './authorization/credential-store';
import { createProviderRegistry } from './provider-registry';
import { chatGptCodexSubscriptionProviderDefinition } from './providers/chatgpt-codex-subscription';

const directories: string[] = [];
const logging = {
  child: () => ({
    error: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    debug: () => undefined,
  }),
} as unknown as RootLogger;

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

const USER_CODE = 'USER-CODE-1234';

function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode(claims)}.sig`;
}

const accessToken = jwt({
  exp: Math.floor(Date.now() / 1000) + 3600,
  'https://api.openai.com/auth': { chatgpt_account_id: 'acct-42' },
});

function stubOpenAi() {
  let polls = 0;
  const fetchMock = vi.fn(
    async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith('/deviceauth/usercode'))
        return Response.json({
          device_auth_id: 'device-1',
          user_code: USER_CODE,
          interval: '0.001',
        });
      if (url.endsWith('/deviceauth/token')) {
        polls += 1;
        if (polls < 2) return new Response('pending', { status: 403 });
        return Response.json({
          authorization_code: 'auth-code',
          code_challenge: 'challenge',
          code_verifier: 'verifier',
        });
      }
      if (url.endsWith('/oauth/token'))
        return Response.json({
          id_token: jwt({}),
          access_token: accessToken,
          refresh_token: 'refresh-1',
        });
      if (url.endsWith('/responses'))
        return new Response('unauthorized', { status: 401 });
      return new Response('unexpected', { status: 500 });
    },
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function createDataDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'klex-provider-auth-'));
  directories.push(path);
  await writeFile(
    join(path, CONFIG_FILE_NAME),
    JSON.stringify({
      configVersion: 2,
      officialName: 'Integration Agent',
      providers: {},
      modelSelection: completeV4StoredConfig.modelSelection,
      mcpServers: {},
    }),
  );
  await createLocalData({
    logging,
    dataDirectory: path,
    klexVersion: KLEX_VERSION,
    stores: [CONFIG_STORE_DEFINITION, PROVIDER_CREDENTIALS_STORE_DEFINITION],
  }).start();
  return path;
}

async function setup(dataDirectory: string) {
  const config = createConfig({ logging, dataDirectory, env: {} });
  await config.start();
  const credentialsPath = join(dataDirectory, 'credentials', 'providers.json');
  const registry = createProviderRegistry({
    logging,
    config,
    definitions: [chatGptCodexSubscriptionProviderDefinition],
    credentials: new ProviderCredentialStore(credentialsPath),
  });
  await registry.start();
  return {
    config,
    registry,
    credentialsPath,
    close: async () => {
      await registry.close();
      await config.close();
    },
  };
}

describe('provider registry managed authorization', () => {
  it('runs sign-in, survives restart, and cleans up on removal', async () => {
    const fetchMock = stubOpenAi();
    const dataDirectory = await createDataDirectory();
    const first = await setup(dataDirectory);
    try {
      expect(
        first.registry
          .listProviderTypes()
          .find((item) => item.type === 'chatgpt-codex-subscription')
          ?.capabilities.interactiveAuthorization,
      ).toBe(true);

      expect(
        await first.registry.addInstance({
          id: 'codex',
          type: 'chatgpt-codex-subscription',
          settings: { authMode: 'managed' },
        }),
      ).toMatchObject({ ok: true });
      expect(first.registry.listInstances()[0]?.authorization).toMatchObject({
        method: 'device-code',
        status: 'required',
      });

      const started = await first.registry.startAuthorization('codex');
      expect(started).toMatchObject({
        ok: true,
        value: {
          verificationUri: 'https://auth.openai.com/codex/device',
          userCode: USER_CODE,
        },
      });

      await vi.waitFor(() =>
        expect(first.registry.listInstances()[0]?.authorization).toMatchObject({
          status: 'authorized',
          accountId: 'acct-42',
        }),
      );
      expect(JSON.stringify(first.registry.listInstances())).not.toContain(
        USER_CODE,
      );
      expect(JSON.stringify(first.config.get())).not.toContain('refresh-1');
      expect(await readFile(first.credentialsPath, 'utf8')).toContain(
        'refresh-1',
      );
      expect(await first.registry.startAuthorization('codex')).toMatchObject({
        ok: false,
        code: 'conflict',
      });

      const exchange = fetchMock.mock.calls.find(([input]) =>
        String(input).endsWith('/oauth/token'),
      );
      const body = String(exchange?.[1]?.body);
      expect(body).toContain('grant_type=authorization_code');
      expect(body).toContain('code_verifier=verifier');
    } finally {
      await first.close();
    }

    const second = await setup(dataDirectory);
    try {
      expect(second.registry.listInstances()[0]?.authorization?.status).toBe(
        'authorized',
      );

      // Model validation must use the stored credential, not fail before the request.
      expect(
        await second.registry.validateModel({
          provider: { id: 'codex' },
          modelId: 'gpt-test',
          purpose: 'chat',
        }),
      ).toMatchObject({ code: 'authentication_required' });
      const generation = fetchMock.mock.calls.find(([input]) =>
        String(input).endsWith('/responses'),
      );
      expect(new Headers(generation?.[1]?.headers).get('Authorization')).toBe(
        `Bearer ${accessToken}`,
      );

      expect(await second.registry.removeInstance('codex')).toMatchObject({
        ok: true,
      });
      expect(await readFile(second.credentialsPath, 'utf8')).not.toContain(
        'refresh-1',
      );
    } finally {
      await second.close();
    }
  });

  it('rejects interactive sign-in for local-cli instances and signs out', async () => {
    stubOpenAi();
    const { config, registry, close } = await setup(
      await createDataDirectory(),
    );
    try {
      // Written directly: addInstance preflights a local Codex CLI, which CI lacks.
      await config.writeProviderInstance('local', {
        type: 'chatgpt-codex-subscription',
        settings: {},
      });
      expect(registry.listInstances()[0]?.authorization).toBeUndefined();
      expect(await registry.startAuthorization('local')).toMatchObject({
        ok: false,
        code: 'unsupported_operation',
      });
      expect(await registry.startAuthorization('missing')).toMatchObject({
        ok: false,
        code: 'not_found',
      });

      await registry.addInstance({
        id: 'managed',
        type: 'chatgpt-codex-subscription',
        settings: { authMode: 'managed' },
      });
      const started = await registry.startAuthorization('managed');
      const again = await registry.startAuthorization('managed');
      expect(again).toEqual(started);
      await vi.waitFor(() =>
        expect(
          registry.listInstances().find((item) => item.id === 'managed')
            ?.authorization?.status,
        ).toBe('authorized'),
      );
      expect(await registry.signOut('managed')).toMatchObject({ ok: true });
      expect(
        registry.listInstances().find((item) => item.id === 'managed')
          ?.authorization?.status,
      ).toBe('required');
    } finally {
      await close();
    }
  });

  it('discards a sign-in start that is cancelled while in flight', async () => {
    const fetchMock = stubOpenAi();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith('/deviceauth/usercode')) await gate;
      return original!(input, init);
    });
    const { registry, close } = await setup(await createDataDirectory());
    try {
      await registry.addInstance({
        id: 'codex',
        type: 'chatgpt-codex-subscription',
        settings: { authMode: 'managed' },
      });
      const started = registry.startAuthorization('codex');
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(await registry.signOut('codex')).toMatchObject({ ok: true });
      release();
      expect(await started).toMatchObject({ ok: false, code: 'conflict' });

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).endsWith('/deviceauth/token'),
        ),
      ).toBe(false);
      expect(registry.listInstances()[0]?.authorization?.status).toBe(
        'required',
      );
    } finally {
      await close();
    }
  });

  it('signs out when the managed endpoint changes', async () => {
    stubOpenAi();
    const { registry, credentialsPath, close } = await setup(
      await createDataDirectory(),
    );
    try {
      await registry.addInstance({
        id: 'codex',
        type: 'chatgpt-codex-subscription',
        settings: { authMode: 'managed' },
      });
      await registry.startAuthorization('codex');
      await vi.waitFor(() =>
        expect(registry.listInstances()[0]?.authorization?.status).toBe(
          'authorized',
        ),
      );

      expect(
        await registry.updateInstance('codex', {
          settings: { baseUrl: 'https://proxy.example.test/codex' },
        }),
      ).toMatchObject({ ok: true });
      expect(registry.listInstances()[0]?.authorization?.status).toBe(
        'required',
      );
      expect(await readFile(credentialsPath, 'utf8')).not.toContain(
        'refresh-1',
      );
    } finally {
      await close();
    }
  });

  it('switches an existing local-cli instance to managed', async () => {
    stubOpenAi();
    const { config, registry, close } = await setup(
      await createDataDirectory(),
    );
    try {
      await config.writeProviderInstance('codex', {
        type: 'chatgpt-codex-subscription',
        settings: {
          codexExecutable: 'codex',
          authFile: '/home/klex/.codex/auth.json',
          baseUrl: 'https://proxy.example.test/codex',
        },
      });
      // Patch keys are never dropped, so a key the mode rejects still fails.
      expect(
        await registry.updateInstance('codex', {
          settings: { authMode: 'managed', codexExecutable: 'codex' },
        }),
      ).toMatchObject({ ok: false, code: 'invalid_configuration' });

      expect(
        await registry.updateInstance('codex', {
          settings: { authMode: 'managed' },
        }),
      ).toMatchObject({ ok: true });
      expect(config.get().providers.codex?.settings).toEqual({
        authMode: 'managed',
        baseUrl: 'https://proxy.example.test/codex',
      });
      expect(registry.listInstances()[0]?.authorization?.status).toBe(
        'required',
      );
    } finally {
      await close();
    }
  });

  it('rejects an environment-dependent managed endpoint', async () => {
    stubOpenAi();
    const { registry, close } = await setup(await createDataDirectory());
    try {
      expect(
        await registry.addInstance({
          id: 'codex',
          type: 'chatgpt-codex-subscription',
          settings: { authMode: 'managed', baseUrl: '${env:CODEX_URL}' },
        }),
      ).toMatchObject({ ok: false, code: 'invalid_configuration' });
    } finally {
      await close();
    }
  });
});
