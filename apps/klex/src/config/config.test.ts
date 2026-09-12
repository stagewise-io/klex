import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { RootLogger } from '@stagewise/logger';

import { createLocalData } from '@/local-data';
import { KLEX_VERSION } from '@/release';

import {
  CONFIG_FILE_NAME,
  type ConfigValidationError,
  createConfig,
  interpolateEnvironment,
} from './config';
import { completeV2Config, emptyModelSelection } from './config.test-fixtures';
import { CONFIG_STORE_DEFINITION } from './storage-definition';
import {
  getProviderSettingsJsonSchema,
  klexConfigSchema,
  migrateLegacyKlexConfig,
  parseKlexConfig,
} from './types';

const directories: string[] = [];
const logging = {
  child: () => ({
    error: () => undefined,
    info: () => undefined,
    warn: () => undefined,
  }),
} as unknown as RootLogger;

async function prepareConfigStore(dataDirectory: string): Promise<void> {
  await createLocalData({
    logging,
    dataDirectory,
    klexVersion: KLEX_VERSION,
    stores: [CONFIG_STORE_DEFINITION],
  }).start();
}

async function directory(withConfig = false): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'klex-config-v2-'));
  directories.push(path);
  if (withConfig) {
    await writeFile(
      join(path, CONFIG_FILE_NAME),
      JSON.stringify({
        configVersion: 2,
        officialName: 'Agent',
        providers: {},
        modelSelection: emptyModelSelection,
        mcpServers: {},
      }),
    );
    await prepareConfigStore(path);
  }
  return path;
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('config v2', () => {
  it('marks OpenRouter attribution settings as provider-managed', () => {
    expect(getProviderSettingsJsonSchema('openrouter')).toMatchObject({
      properties: {
        httpReferer: { readOnly: true },
        appName: { readOnly: true },
      },
    });
  });

  it('requires an explicitly provisioned config file', async () => {
    const dataDirectory = await directory();
    const config = createConfig({ logging, dataDirectory });
    await expect(config.start()).rejects.toThrow(
      'Required config file not found',
    );
  });

  it('accepts a complete v2 config with multiple same-type instances, custom routing, and manual model overrides', () => {
    const parsed = klexConfigSchema.parse(completeV2Config);

    expect(parsed.configVersion).toBe(2);
    expect(parsed.providers['openai-primary']?.type).toBe('openai');
    expect(parsed.providers['openai-secondary']?.type).toBe('openai');
    expect(parsed.providers['openai-internal']?.settings).toMatchObject({
      baseUrl: 'https://models.internal.example/v1',
    });
    expect(parsed.providers['custom-chat']).toMatchObject({
      type: 'chat-completions',
      settings: { baseUrl: 'https://inference.example/v1' },
      knownModels: {
        'org:model:v2': {
          displayName: 'Manually overridden name',
          contextSize: 65_536,
        },
      },
    });
    expect(parsed.modelSelection.chat[1]).toEqual({
      providerId: 'custom-chat',
      modelId: 'org:model:v2',
      providerOptions: { openai: { reasoningEffort: 'high' } },
    });
  });

  it('migrates preset and single-endpoint v1 providers once and preserves native model colons', async () => {
    const dataDirectory = await directory();
    await writeFile(
      join(dataDirectory, CONFIG_FILE_NAME),
      JSON.stringify({
        officialName: 'Migration',
        providers: {
          remote: {
            preset: 'openai',
            auth: { apiKey: '${env:OPENAI_API_KEY}' },
            knownModels: { 'org:model:v2': { displayName: 'Model' } },
          },
          local: {
            endpoints: {
              ollama: {
                url: 'http://localhost:11434/v1',
                format: 'chat-completions',
                auth: {},
                knownModels: { 'model:8b': {} },
              },
            },
          },
        },
        modelSelection: {
          chat: ['remote:org:model:v2', 'local:ollama:model:8b'],
          compaction: [],
          memory: [],
          imageVision: [],
          audioListening: [],
          voice: { sts: [], tts: [], stt: [] },
        },
        mcpServers: {},
      }),
    );
    await prepareConfigStore(dataDirectory);
    const config = createConfig({
      logging,
      dataDirectory,
      env: { OPENAI_API_KEY: 'secret' },
    });
    await config.start();

    expect(config.get().providers.remote).toMatchObject({
      type: 'openai',
      settings: { apiKey: '${env:OPENAI_API_KEY}' },
    });
    expect(config.get().providers.local).toMatchObject({
      type: 'chat-completions',
      settings: { baseUrl: 'http://localhost:11434/v1' },
    });
    expect(config.get().modelSelection.chat).toEqual([
      { providerId: 'remote', modelId: 'org:model:v2' },
      { providerId: 'local', modelId: 'model:8b' },
    ]);
    expect(
      config.resolveModel({ providerId: 'remote', modelId: 'org:model:v2' })
        .settings,
    ).toMatchObject({ apiKey: 'secret' });
    const persisted = JSON.parse(
      await readFile(join(dataDirectory, CONFIG_FILE_NAME), 'utf8'),
    );
    expect(persisted).toMatchObject(
      JSON.parse(JSON.stringify(config.get())) as Record<string, unknown>,
    );
    expect(persisted._klex).toMatchObject({
      store: 'config',
      schemaVersion: 2,
    });
    expect(parseKlexConfig(persisted).configVersion).toBe(2);
    await config.close();
  });

  it('assigns deterministic instance IDs when migrating a multi-endpoint provider', () => {
    const parsed = migrateLegacyKlexConfig({
      officialName: 'Migration',
      providers: {
        remote: {
          endpoints: {
            primary: {
              url: 'https://primary.example/v1',
              format: 'chat-completions',
              auth: {},
            },
            fallback: {
              url: 'https://fallback.example/v1',
              format: 'open-responses',
              auth: {},
            },
          },
        },
      },
      modelSelection: {
        chat: [
          {
            model: 'remote:primary:org:model:v2',
            providerOptions: { openai: { reasoningEffort: 'medium' } },
          },
          'remote:fallback:org:model:v3',
        ],
      },
    });

    expect(Object.keys(parsed.providers).sort()).toEqual([
      'remote--fallback',
      'remote--primary',
    ]);
    expect(parsed.modelSelection.chat).toEqual([
      {
        providerId: 'remote--primary',
        modelId: 'org:model:v2',
        providerOptions: { openai: { reasoningEffort: 'medium' } },
      },
      { providerId: 'remote--fallback', modelId: 'org:model:v3' },
    ]);
  });

  it('preserves complete legacy provider, model, selection, and environment semantics', () => {
    const parsed = migrateLegacyKlexConfig({
      officialName: 'Complete migration',
      providers: {
        cloud: {
          preset: 'anthropic',
          auth: { apiKey: '{env:ANTHROPIC_KEY}' },
          knownModels: {
            'claude:model:v1': {
              displayName: 'Claude override',
              contextSize: 100_000,
              capabilities: { voice: { tts: true } },
            },
          },
        },
        gateways: {
          endpoints: {
            primary: {
              url: 'https://primary.example/v1',
              format: 'chat-completions',
              auth: {
                headers: {
                  Authorization: 'Bearer {env:GATEWAY_TOKEN}',
                  'X-Literal': '$${env:DO_NOT_RESOLVE}',
                },
              },
              knownModels: {
                'org:model:v2': {
                  capabilities: {
                    input: {
                      image: {
                        mediaTypes: ['image/png'],
                        maxBytes: 1024,
                      },
                    },
                  },
                },
              },
            },
            fallback: {
              url: 'https://fallback.example/v1',
              format: 'messages',
              auth: {},
            },
          },
        },
      },
      modelSelection: {
        chat: [
          {
            model: 'gateways:primary:org:model:v2',
            providerOptions: { openai: { reasoningEffort: 'high' } },
          },
        ],
        compaction: ['cloud:claude:model:v1'],
        memory: [],
        imageVision: ['gateways:primary:org:model:v2'],
        audioListening: [],
        voice: {
          sts: [],
          tts: ['cloud:claude:model:v1'],
          stt: ['gateways:fallback:voice:model:v3'],
        },
      },
      mcpServers: {},
    });

    expect(parsed.providers.cloud).toMatchObject({
      type: 'anthropic',
      settings: { apiKey: '${env:ANTHROPIC_KEY}' },
      knownModels: {
        'claude:model:v1': {
          displayName: 'Claude override',
          contextSize: 100_000,
          capabilities: { voice: { tts: true } },
        },
      },
    });
    expect(parsed.providers['gateways--primary']).toMatchObject({
      type: 'chat-completions',
      settings: {
        headers: {
          Authorization: 'Bearer ${env:GATEWAY_TOKEN}',
          'X-Literal': '$${env:DO_NOT_RESOLVE}',
        },
      },
      knownModels: {
        'org:model:v2': {
          capabilities: { input: { image: { maxBytes: 1024 } } },
        },
      },
    });
    expect(parsed.providers['gateways--fallback']?.type).toBe(
      'anthropic-messages',
    );
    expect(parsed.modelSelection).toMatchObject({
      chat: [
        {
          providerId: 'gateways--primary',
          modelId: 'org:model:v2',
          providerOptions: { openai: { reasoningEffort: 'high' } },
        },
      ],
      compaction: [{ providerId: 'cloud', modelId: 'claude:model:v1' }],
      imageVision: [
        { providerId: 'gateways--primary', modelId: 'org:model:v2' },
      ],
      voice: {
        tts: [{ providerId: 'cloud', modelId: 'claude:model:v1' }],
        stt: [
          {
            providerId: 'gateways--fallback',
            modelId: 'voice:model:v3',
          },
        ],
      },
    });
  });

  it('migrates legacy OpenAI-compatible voice endpoints without blocking startup', () => {
    const parsed = migrateLegacyKlexConfig({
      officialName: 'Voice migration',
      providers: {
        voice: {
          endpoints: {
            realtime: {
              url: 'https://voice.example/v1',
              format: 'realtime',
              auth: { apiKey: '{env:VOICE_KEY}' },
            },
          },
        },
      },
      modelSelection: {
        voice: { sts: ['voice:realtime:voice:model'] },
      },
      mcpServers: {},
    });
    expect(parsed.providers.voice).toMatchObject({
      type: 'openai',
      settings: {
        baseUrl: 'https://voice.example/v1',
        apiKey: '${env:VOICE_KEY}',
      },
    });
    expect(parsed.modelSelection.voice.sts).toEqual([
      { providerId: 'voice', modelId: 'voice:model' },
    ]);
  });

  it('commits structural migration before runtime environment validation', async () => {
    const dataDirectory = await directory();
    const input = {
      officialName: 'Atomic migration',
      providers: {
        remote: {
          preset: 'openai',
          auth: { apiKey: '{env:MISSING}' },
        },
      },
      modelSelection: { chat: ['remote:model'] },
      mcpServers: {},
    };
    const configPath = join(dataDirectory, CONFIG_FILE_NAME);
    await writeFile(configPath, JSON.stringify(input));
    await prepareConfigStore(dataDirectory);
    const config = createConfig({ logging, dataDirectory, env: {} });

    await expect(config.start()).rejects.toThrow(
      "Required environment variable 'MISSING' is not defined",
    );
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toMatchObject({
      configVersion: 2,
      providers: {
        remote: {
          type: 'openai',
          settings: { apiKey: '${env:MISSING}' },
        },
      },
      modelSelection: {
        chat: [{ providerId: 'remote', modelId: 'model' }],
      },
    });
  });

  it('fails migration instead of overwriting colliding instance IDs', () => {
    expect(() =>
      migrateLegacyKlexConfig({
        officialName: 'Migration',
        providers: {
          remote: {
            endpoints: {
              primary: {
                url: 'https://primary.example/v1',
                format: 'chat-completions',
                auth: {},
              },
              fallback: {
                url: 'https://fallback.example/v1',
                format: 'chat-completions',
                auth: {},
              },
            },
          },
          'remote--primary': {
            preset: 'openai',
            auth: {},
          },
        },
      }),
    ).toThrow("Provider migration ID collision at 'remote--primary'");
  });

  it('interpolates environment variables recursively without changing persisted placeholders', async () => {
    const dataDirectory = await directory(true);
    const config = createConfig({
      logging,
      dataDirectory,
      env: { HOST: 'example.test', TENANT: 'acme', TOKEN: 'resolved' },
    });
    await config.start();
    await config.writeProviderInstance('custom', {
      type: 'chat-completions',
      settings: {
        baseUrl: 'https://${env:HOST}/v1/${env:TENANT}',
        headers: {
          Authorization: 'Bearer ${env:TOKEN}',
          'X-Literal': '$${env:DO_NOT_RESOLVE}',
        },
      },
    });

    expect(
      config.resolveModel({ providerId: 'custom', modelId: 'model' }).settings,
    ).toMatchObject({
      baseUrl: 'https://example.test/v1/acme',
      headers: {
        Authorization: 'Bearer resolved',
        'X-Literal': '${env:DO_NOT_RESOLVE}',
      },
    });
    expect(config.get().providers.custom?.settings).toMatchObject({
      baseUrl: 'https://${env:HOST}/v1/${env:TENANT}',
      headers: {
        Authorization: 'Bearer ${env:TOKEN}',
        'X-Literal': '$${env:DO_NOT_RESOLVE}',
      },
    });
    await config.close();
  });

  it('interpolates nested arrays without interpolating object keys', () => {
    expect(
      interpolateEnvironment(
        {
          nested: [{ value: 'prefix-${env:TOKEN}-suffix' }],
          '${env:KEY_IS_NOT_INTERPOLATED}': 'value',
        },
        { TOKEN: 'resolved', KEY_IS_NOT_INTERPOLATED: 'changed' },
      ),
    ).toEqual({
      nested: [{ value: 'prefix-resolved-suffix' }],
      '${env:KEY_IS_NOT_INTERPOLATED}': 'value',
    });
  });

  it('rejects unresolved environment references', async () => {
    const dataDirectory = await directory(true);
    const config = createConfig({ logging, dataDirectory, env: {} });
    await config.start();
    const update = config.writeProviderInstance('custom', {
      type: 'openai',
      settings: { apiKey: '${env:MISSING}' },
    });
    await expect(update).rejects.toMatchObject({
      name: 'ConfigValidationError',
      code: 'environment_missing',
      message: "Required environment variable 'MISSING' is not defined",
    } satisfies Partial<ConfigValidationError>);
    expect(config.get().providers.custom).toBeUndefined();
    await config.close();
  });

  it('keeps replacement atomic and notifies subscribers after serialized mutations', async () => {
    const config = createConfig({
      logging,
      dataDirectory: await directory(true),
      env: { API_KEY: 'resolved' },
    });
    await config.start();
    const notifications: string[] = [];
    const unsubscribe = config.subscribe((value) => {
      notifications.push(value.officialName);
    });

    const original = config.get();
    await expect(
      config.replace({ configVersion: 2, officialName: '' }),
    ).rejects.toThrow();
    expect(config.get()).toEqual(original);

    await Promise.all([
      config.mutate((current) => ({ ...current, officialName: 'Updated' })),
      config.addMcpServer('local', { command: 'node', args: ['server.js'] }),
      config.writeProviderInstance('openai-main', {
        type: 'openai',
        settings: { apiKey: '${env:API_KEY}' },
      }),
    ]);
    expect(config.getMcpServers()).toEqual({
      local: { command: 'node', args: ['server.js'] },
    });
    expect(config.get().providers['openai-main']).toMatchObject({
      type: 'openai',
      settings: { apiKey: '${env:API_KEY}' },
    });
    expect(notifications).toHaveLength(3);

    await config.updateMcpServer('local', { command: 'bun' });
    await config.writeModelSelection({
      ...emptyModelSelection,
      chat: [{ providerId: 'openai-main', modelId: 'gpt-test' }],
    });
    expect(config.getModelSelection('chat')).toEqual([
      { providerId: 'openai-main', modelId: 'gpt-test' },
    ]);
    await config.removeMcpServer('local');
    await config.deleteProviderInstance('openai-main');
    expect(config.getMcpServers()).toEqual({});
    expect(config.get().providers).toEqual({});

    unsubscribe();
    await config.mutate((current) => ({ ...current, officialName: 'Ignored' }));
    expect(notifications).toHaveLength(7);
    await config.close();
  });

  it('resolves realtime providers with non-secret model metadata separated from credentials', async () => {
    const dataDirectory = await directory(true);
    const config = createConfig({
      logging,
      dataDirectory,
      env: { REALTIME_KEY: 'sk-realtime' },
    });
    await config.start();
    await config.writeProviderInstance('openai-voice', {
      type: 'openai',
      settings: { apiKey: '${env:REALTIME_KEY}' },
      knownModels: {
        'gpt-realtime': {
          displayName: 'Realtime Voice',
          contextSize: 32_000,
          capabilities: {
            voice: { sts: true },
            input: { audio: { mediaTypes: ['audio/pcm'] } },
          },
        },
      },
    });
    await config.writeModelSelection({
      ...emptyModelSelection,
      voice: {
        ...emptyModelSelection.voice,
        sts: [{ providerId: 'openai-voice', modelId: 'gpt-realtime' }],
      },
    });

    const resolved = config.resolveRealtimeProvider();

    expect(resolved).toMatchObject({
      kind: 'openai-realtime',
      model: {
        modelId: 'gpt-realtime',
        displayName: 'Realtime Voice',
        contextSize: 32_000,
        inputCapabilities: { audio: { mediaTypes: ['audio/pcm'] } },
      },
      config: { modelId: 'gpt-realtime', apiKey: 'sk-realtime' },
    });
    // Credentials and endpoints stay confined to the provider construction slice.
    expect(resolved?.model).not.toHaveProperty('apiKey');
    expect(resolved?.model).not.toHaveProperty('websocketUrl');
    await config.close();
  });

  it('validates explicit object references for voice and arbitrary model IDs', () => {
    const parsed = klexConfigSchema.parse({
      configVersion: 2,
      officialName: 'Agent',
      providers: {
        p: {
          type: 'openai',
          settings: { apiKey: 'test-key' },
          knownModels: { 'org:model:v3': {} },
        },
      },
      modelSelection: {
        chat: [{ providerId: 'p', modelId: 'org:model:v3' }],
        compaction: [],
        memory: [],
        imageVision: [],
        audioListening: [],
        voice: {
          sts: [{ providerId: 'p', modelId: 'voice:model' }],
          tts: [],
          stt: [],
        },
      },
      mcpServers: {},
    });
    expect(parsed.modelSelection.voice.sts[0]?.modelId).toBe('voice:model');
  });
});
