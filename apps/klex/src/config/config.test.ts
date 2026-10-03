import { randomUUID } from 'node:crypto';
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
import {
  completeV2Config,
  completeV4StoredConfig,
  completeV5StoredConfig,
  emptyModelSelection,
} from './config.test-fixtures';
import { CONFIG_STORE_DEFINITION } from './storage-definition';
import {
  dropLegacyTelemetryConfig,
  getProviderSettingsJsonSchema,
  klexConfigSchema,
  migrateLegacyKlexConfig,
  nestMemoryExtensionConfig,
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
        modelSelection: completeV4StoredConfig.modelSelection,
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
  it('freezes historical API/kind/provider shapes and round-trips evaluation selections', () => {
    const entry = {
      providerId: 'openai-primary',
      modelId: 'gpt-4.1',
      api: 'evaluation',
      attemptTimeoutMs: 1500,
    };
    const input = {
      ...completeV2Config,
      modelSelection: { ...emptyModelSelection, instincts: [entry] },
    };
    expect(parseKlexConfig(input).modelSelection.instincts).toEqual([entry]);
    const historical = CONFIG_STORE_DEFINITION.versions.find(
      ({ version }) => version === 7,
    )!.schema;
    expect(historical.safeParse(input).success).toBe(false);
    expect(
      historical.safeParse({
        ...completeV2Config,
        providers: {
          native: { type: 'typesafe-ai', settings: { apiKey: 'test' } },
        },
      }).success,
    ).toBe(false);
    expect(
      historical.safeParse({
        ...completeV2Config,
        providers: {
          ...completeV2Config.providers,
          'openai-primary': {
            ...completeV2Config.providers['openai-primary'],
            knownModels: { 'gpt-4.1': { kind: 'evaluation' } },
          },
        },
      }).success,
    ).toBe(false);
    expect(() =>
      parseKlexConfig({
        ...input,
        modelSelection: { ...input.modelSelection, chat: [entry] },
      }),
    ).toThrow();
  });
  it('accepts legacy telemetry settings only in stored schemas before 4', () => {
    for (const telemetry of [
      { level: 'off' },
      { level: 'minimum' },
      { level: 'advanced', instanceId: randomUUID() },
      { level: 'debug', debugUntil: '2099-01-01T00:00:00.000Z' },
    ]) {
      const input: Record<string, unknown> = {
        ...completeV4StoredConfig,
        telemetry,
      };
      for (const { version, schema } of CONFIG_STORE_DEFINITION.versions) {
        if (version === 1) continue;
        if (version >= 4) {
          expect(() => schema.parse(input)).toThrow();
        } else {
          expect(() => schema.parse(input)).not.toThrow();
        }
      }
      expect(dropLegacyTelemetryConfig(input)).not.toHaveProperty('telemetry');
    }
  });

  it('removes telemetry from a schema 3 config file during migration', async () => {
    const dataDirectory = await directory();
    const configPath = join(dataDirectory, CONFIG_FILE_NAME);
    await writeFile(
      configPath,
      JSON.stringify({
        _klex: {
          store: 'config',
          schemaVersion: 3,
          compatibilityVersion: 6,
          minimumKlexVersion: '0.8.0',
          writtenByKlexVersion: '0.9.1',
        },
        ...completeV4StoredConfig,
        telemetry: { level: 'advanced', instanceId: randomUUID() },
      }),
    );

    await prepareConfigStore(dataDirectory);

    const persisted = JSON.parse(await readFile(configPath, 'utf8')) as Record<
      string,
      unknown
    >;
    expect(persisted).not.toHaveProperty('telemetry');
    expect(persisted._klex).toMatchObject({
      store: 'config',
      schemaVersion: 8,
    });
    expect(persisted.extensions).toEqual({
      memory: {
        episodes: {
          maxCharacters: 50_000,
          maxDurationMs: 3_600_000,
          idleTimeoutMs: 450_000,
        },
      },
    });
  });

  it('nests the memory settings of a schema 4 config file during migration', async () => {
    const dataDirectory = await directory();
    const configPath = join(dataDirectory, CONFIG_FILE_NAME);
    await writeFile(
      configPath,
      JSON.stringify({
        _klex: {
          store: 'config',
          schemaVersion: 4,
          compatibilityVersion: 6,
          minimumKlexVersion: '0.9.2',
          writtenByKlexVersion: '0.9.2',
        },
        ...completeV4StoredConfig,
        episodeFinishIdleTriggerTimeMs: 300_000,
        memoryWriteIntervalMs: 12_000,
        memoryWriteStepInterval: 7,
      }),
    );

    await prepareConfigStore(dataDirectory);

    const persisted = JSON.parse(await readFile(configPath, 'utf8')) as Record<
      string,
      unknown
    >;
    expect(persisted._klex).toMatchObject({ schemaVersion: 8 });
    expect(persisted).not.toHaveProperty('episodeFinishIdleTriggerTimeMs');
    expect(persisted).not.toHaveProperty('memoryWriteIntervalMs');
    expect(persisted).not.toHaveProperty('memoryWriteStepInterval');
    expect(persisted.extensions).toEqual({
      memory: {
        episodes: {
          maxCharacters: 50_000,
          maxDurationMs: 3_600_000,
          idleTimeoutMs: 300_000,
        },
      },
    });
    expect(persisted.officialName).toBe(completeV2Config.officialName);
  });

  it('fills the historical memory defaults for a schema 4 config without them', () => {
    const {
      episodeFinishIdleTriggerTimeMs: _idle,
      memoryWriteIntervalMs: _interval,
      memoryWriteStepInterval: _steps,
      ...withoutMemoryKeys
    } = completeV4StoredConfig;
    expect(
      nestMemoryExtensionConfig(withoutMemoryKeys).extensions.memory.episodes,
    ).toEqual({
      maxCharacters: 50_000,
      maxDurationMs: 3_600_000,
      idleTimeoutMs: 300_000,
    });
  });

  it('rejects the old root memory keys in schema 5 and `extensions` before schema 5', () => {
    const current = CONFIG_STORE_DEFINITION.versions.find(
      ({ version }) => version === 5,
    );
    const v4 = CONFIG_STORE_DEFINITION.versions.find(
      ({ version }) => version === 4,
    );
    expect(() => current?.schema.parse(completeV4StoredConfig)).toThrow();
    expect(() => v4?.schema.parse(completeV2Config)).toThrow();
    expect(() => current?.schema.parse(completeV5StoredConfig)).not.toThrow();
    expect(() => v4?.schema.parse(completeV4StoredConfig)).not.toThrow();
  });

  it.each([true, false])(
    'migrates schema 5 settings to instinct without changing enabled=%s',
    async (enabled) => {
      const dataDirectory = await directory();
      const configPath = join(dataDirectory, CONFIG_FILE_NAME);
      const settings = {
        ...completeV2Config.instinct,
        enabled,
        timeoutMs: 12_345,
        classifierTimeoutMs: 1_234,
        recentMessageCount: 7,
        deltaMessageCap: 31,
        historyCharacterCap: 25_000,
        messageCharacterCap: 3_000,
        contextCharacterCap: 4_000,
      };
      await writeFile(
        configPath,
        JSON.stringify({
          ...completeV5StoredConfig,
          preflight: settings,
          _klex: {
            store: 'config',
            schemaVersion: 5,
            compatibilityVersion: 7,
            minimumKlexVersion: '0.9.2',
            writtenByKlexVersion: '0.11.0',
          },
        }),
      );

      await prepareConfigStore(dataDirectory);
      const migratedBytes = await readFile(configPath, 'utf8');
      const migrated = JSON.parse(migratedBytes);
      expect(migrated).not.toHaveProperty('preflight');
      expect(migrated.instinct).toEqual(settings);
      expect(migrated.providers).toEqual(completeV2Config.providers);
      expect(migrated.modelSelection).toEqual(completeV2Config.modelSelection);
      expect(migrated.extensions).toEqual(completeV2Config.extensions);
      expect(migrated._klex).toMatchObject({
        schemaVersion: 8,
        compatibilityVersion: 10,
      });
      expect(parseKlexConfig(migrated).instinct).toEqual(settings);
      await prepareConfigStore(dataDirectory);
      expect(await readFile(configPath, 'utf8')).toBe(migratedBytes);
    },
  );

  it('keeps model selection in stored schemas 2–4 frozen', () => {
    for (const version of [2, 3, 4]) {
      const schema = CONFIG_STORE_DEFINITION.versions.find(
        (entry) => entry.version === version,
      )!.schema;
      expect(schema.safeParse(completeV4StoredConfig).success).toBe(true);
      for (const purpose of ['classifier', 'instincts']) {
        expect(
          schema.safeParse({
            ...completeV4StoredConfig,
            modelSelection: {
              ...(completeV4StoredConfig.modelSelection as object),
              [purpose]: [],
            },
          }).success,
        ).toBe(false);
      }
    }
    expect(
      dropLegacyTelemetryConfig(completeV4StoredConfig).modelSelection,
    ).not.toHaveProperty('classifier');
    expect(
      dropLegacyTelemetryConfig(completeV4StoredConfig).modelSelection,
    ).not.toHaveProperty('instincts');
  });

  it('migrates schema 6 classifier models to instincts and rejects downgrade without mutation', async () => {
    const dataDirectory = await directory();
    const configPath = join(dataDirectory, CONFIG_FILE_NAME);
    const { preflight, ...v5 } = completeV5StoredConfig;
    const models = [
      {
        providerId: 'openai-primary',
        modelId: 'gpt-4.1',
        providerOptions: { openai: { reasoningEffort: 'low' } },
      },
      { providerId: 'custom-chat', modelId: 'org:model:v2' },
    ];
    await writeFile(
      configPath,
      JSON.stringify({
        ...v5,
        instinct: preflight,
        modelSelection: {
          ...completeV5StoredConfig.modelSelection,
          classifier: models,
        },
        _klex: {
          store: 'config',
          schemaVersion: 6,
          compatibilityVersion: 8,
          minimumKlexVersion: '0.11.0',
          writtenByKlexVersion: '0.11.0',
        },
      }),
    );
    await prepareConfigStore(dataDirectory);
    const after = await readFile(configPath, 'utf8');
    const migrated = JSON.parse(after);
    expect(migrated.modelSelection.instincts).toEqual(
      models.map((entry) => ({ ...entry, api: 'generation' })),
    );
    expect(migrated.modelSelection).not.toHaveProperty('classifier');
    expect(migrated._klex).toMatchObject({
      schemaVersion: 8,
      compatibilityVersion: 10,
    });
    await prepareConfigStore(dataDirectory);
    expect(await readFile(configPath, 'utf8')).toBe(after);
    await expect(
      createLocalData({
        logging,
        dataDirectory,
        klexVersion: '0.11.0',
        stores: [
          {
            ...CONFIG_STORE_DEFINITION,
            schemaVersion: 6,
            compatibilityVersion: 8,
            versions: CONFIG_STORE_DEFINITION.versions.slice(0, 6),
            migrations: CONFIG_STORE_DEFINITION.migrations.slice(0, 5),
          },
        ],
      }).start(),
    ).rejects.toThrow(/newer Klex version/);
    expect(await readFile(configPath, 'utf8')).toBe(after);
  });

  it('keeps schema 5 validation historical and rejects the old name in schema 7', () => {
    const oldSchema = CONFIG_STORE_DEFINITION.versions.find(
      ({ version }) => version === 5,
    )?.schema;
    const newSchema = CONFIG_STORE_DEFINITION.versions.find(
      ({ version }) => version === 7,
    )?.schema;
    expect(oldSchema?.safeParse(completeV5StoredConfig).success).toBe(true);
    expect(newSchema?.safeParse(completeV2Config).success).toBe(true);
    expect(oldSchema?.safeParse(completeV2Config).success).toBe(false);
    expect(newSchema?.safeParse(completeV5StoredConfig).success).toBe(false);
  });

  it('rejects instinct config for the previous schema 5 reader without mutation', async () => {
    const dataDirectory = await directory(true);
    const configPath = join(dataDirectory, CONFIG_FILE_NAME);
    const before = await readFile(configPath);
    const olderDefinition = {
      ...CONFIG_STORE_DEFINITION,
      schemaVersion: 5,
      compatibilityVersion: 7,
      versions: CONFIG_STORE_DEFINITION.versions.slice(0, 5),
      migrations: CONFIG_STORE_DEFINITION.migrations.slice(0, 4),
    };
    await expect(
      createLocalData({
        logging,
        dataDirectory,
        klexVersion: '0.11.0',
        stores: [olderDefinition],
      }).start(),
    ).rejects.toThrow(/newer Klex version/);
    expect(await readFile(configPath)).toEqual(before);
  });

  it.each([5, 6])(
    'restores config after a failed migration from schema %s and succeeds on retry',
    async (from) => {
      const dataDirectory = await directory();
      const configPath = join(dataDirectory, CONFIG_FILE_NAME);
      await writeFile(
        configPath,
        JSON.stringify({
          ...completeV5StoredConfig,
          _klex: {
            store: 'config',
            schemaVersion: 5,
            compatibilityVersion: 7,
            minimumKlexVersion: '0.9.2',
            writtenByKlexVersion: '0.11.0',
          },
        }),
      );
      const before = await readFile(configPath);
      const failingDefinition = {
        ...CONFIG_STORE_DEFINITION,
        migrations: CONFIG_STORE_DEFINITION.migrations.map((migration) =>
          migration.from === from
            ? {
                ...migration,
                up: () => {
                  throw new Error('rename failed');
                },
              }
            : migration,
        ),
      };
      await expect(
        createLocalData({
          logging,
          dataDirectory,
          klexVersion: KLEX_VERSION,
          stores: [failingDefinition],
        }).start(),
      ).rejects.toThrow(/original data was restored/);
      expect(await readFile(configPath)).toEqual(before);
      await prepareConfigStore(dataDirectory);
      expect(JSON.parse(await readFile(configPath, 'utf8')).instinct).toEqual(
        completeV2Config.instinct,
      );
    },
  );

  it('leaves invalid historical subsystem settings untouched', async () => {
    const dataDirectory = await directory();
    const configPath = join(dataDirectory, CONFIG_FILE_NAME);
    await writeFile(
      configPath,
      JSON.stringify({
        ...completeV5StoredConfig,
        preflight: { ...completeV2Config.instinct, timeoutMs: -1 },
        _klex: {
          store: 'config',
          schemaVersion: 5,
          compatibilityVersion: 7,
          minimumKlexVersion: '0.9.2',
          writtenByKlexVersion: '0.11.0',
        },
      }),
    );
    const before = await readFile(configPath);
    await expect(prepareConfigStore(dataDirectory)).rejects.toThrow();
    expect(await readFile(configPath)).toEqual(before);
  });

  it('leaves an invalid schema 4 config file untouched', async () => {
    const dataDirectory = await directory();
    const configPath = join(dataDirectory, CONFIG_FILE_NAME);
    await writeFile(
      configPath,
      JSON.stringify({
        _klex: {
          store: 'config',
          schemaVersion: 4,
          compatibilityVersion: 6,
          minimumKlexVersion: '0.9.2',
          writtenByKlexVersion: '0.9.2',
        },
        ...completeV4StoredConfig,
        episodeFinishIdleTriggerTimeMs: 0,
      }),
    );
    const before = await readFile(configPath);

    await expect(prepareConfigStore(dataDirectory)).rejects.toThrow();

    expect(await readFile(configPath)).toEqual(before);
  });

  it('rejects a current config for a schema 4 reader before mutation', async () => {
    const dataDirectory = await directory(true);
    const configPath = join(dataDirectory, CONFIG_FILE_NAME);
    const beforeDowngrade = await readFile(configPath);

    const olderDefinition = {
      ...CONFIG_STORE_DEFINITION,
      schemaVersion: 4,
      versions: CONFIG_STORE_DEFINITION.versions.slice(0, 4),
      migrations: CONFIG_STORE_DEFINITION.migrations.slice(0, 3),
    };
    await expect(
      createLocalData({
        logging,
        dataDirectory,
        klexVersion: '0.9.2',
        stores: [olderDefinition],
      }).start(),
    ).rejects.toThrow(/newer Klex version/);

    expect(await readFile(configPath)).toEqual(beforeDowngrade);
  });

  it('rejects a current config for a schema 3 reader before mutation', async () => {
    const dataDirectory = await directory(true);
    const configPath = join(dataDirectory, CONFIG_FILE_NAME);
    const beforeDowngrade = await readFile(configPath);

    const olderDefinition = {
      ...CONFIG_STORE_DEFINITION,
      schemaVersion: 3,
      versions: CONFIG_STORE_DEFINITION.versions.slice(0, 3),
      migrations: CONFIG_STORE_DEFINITION.migrations.slice(0, 2),
    };
    await expect(
      createLocalData({
        logging,
        dataDirectory,
        klexVersion: '0.9.1',
        stores: [olderDefinition],
      }).start(),
    ).rejects.toThrow(/newer Klex version/);

    expect(await readFile(configPath)).toEqual(beforeDowngrade);
  });

  it('records the current config compatibility metadata', async () => {
    expect(CONFIG_STORE_DEFINITION.compatibilityVersion).toBe(10);
    expect(CONFIG_STORE_DEFINITION.minimumKlexVersion).toBe('0.13.0');

    const dataDirectory = await directory();
    await writeFile(
      join(dataDirectory, CONFIG_FILE_NAME),
      JSON.stringify({
        configVersion: 2,
        officialName: 'Agent',
        providers: {},
        modelSelection: {
          ...(completeV4StoredConfig.modelSelection as object),
          consult: [{ providerId: 'remote', modelId: 'reasoner' }],
        },
        mcpServers: {},
      }),
    );
    await prepareConfigStore(dataDirectory);

    const persisted = JSON.parse(
      await readFile(join(dataDirectory, CONFIG_FILE_NAME), 'utf8'),
    ) as {
      _klex: { compatibilityVersion: number; minimumKlexVersion: string };
    };
    expect(persisted._klex).toMatchObject({
      compatibilityVersion: 10,
      minimumKlexVersion: '0.13.0',
    });
  });

  it('rejects a consult config for an older reader before mutation', async () => {
    const dataDirectory = await directory();
    await writeFile(
      join(dataDirectory, CONFIG_FILE_NAME),
      JSON.stringify({
        configVersion: 2,
        officialName: 'Agent',
        providers: {},
        modelSelection: {
          ...(completeV4StoredConfig.modelSelection as object),
          consult: [{ providerId: 'remote', modelId: 'reasoner' }],
        },
        mcpServers: {},
      }),
    );
    await prepareConfigStore(dataDirectory);
    const configPath = join(dataDirectory, CONFIG_FILE_NAME);
    const beforeDowngrade = await readFile(configPath);

    const olderDefinition = {
      ...CONFIG_STORE_DEFINITION,
      compatibilityVersion: 5,
      minimumKlexVersion: '0.7.0',
    };
    await expect(
      createLocalData({
        logging,
        dataDirectory,
        klexVersion: '0.7.0',
        stores: [olderDefinition],
      }).start(),
    ).rejects.toThrow(/compatibility/);

    expect(await readFile(configPath)).toEqual(beforeDowngrade);
  });

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
    expect(parsed.extensions.memory.episodes.idleTimeoutMs).toBe(600_000);
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

  it('defaults and validates the timezone', () => {
    const base = {
      configVersion: 2,
      officialName: 'Agent',
      providers: {},
      modelSelection: emptyModelSelection,
      mcpServers: {},
    };

    expect(klexConfigSchema.parse(base).timezone).toBe('UTC');
    expect(
      klexConfigSchema.parse({ ...base, timezone: ' Europe/Berlin ' }).timezone,
    ).toBe('Europe/Berlin');
    expect(() =>
      klexConfigSchema.parse({ ...base, timezone: 'Fake/Zone' }),
    ).toThrow('Timezone must be a valid IANA identifier');
  });

  it('defaults and validates the episode rotation limits', () => {
    const base = {
      configVersion: 2,
      officialName: 'Agent',
      providers: {},
      modelSelection: emptyModelSelection,
      mcpServers: {},
    };
    const withEpisodes = (episodes: Record<string, unknown>) => ({
      ...base,
      extensions: { memory: { episodes } },
    });

    expect(klexConfigSchema.parse(base).extensions).toEqual({
      memory: {
        episodes: {
          maxCharacters: 50_000,
          maxDurationMs: 3_600_000,
          idleTimeoutMs: 600_000,
        },
      },
    });
    expect(
      klexConfigSchema.parse(withEpisodes({ maxCharacters: 10_000 })).extensions
        .memory.episodes,
    ).toEqual({
      maxCharacters: 10_000,
      maxDurationMs: 3_600_000,
      idleTimeoutMs: 600_000,
    });
    for (const invalid of [
      { maxCharacters: 0 },
      { maxCharacters: 1.5 },
      { maxDurationMs: -1 },
      { maxDurationMs: 2_147_483_648 },
      { idleTimeoutMs: 0 },
      { idleTimeoutMs: 1.5 },
      { unknown: 1 },
    ]) {
      expect(() => klexConfigSchema.parse(withEpisodes(invalid))).toThrow();
    }
    expect(() =>
      klexConfigSchema.parse({ ...base, extensions: { unknown: {} } }),
    ).toThrow();
    expect(() =>
      klexConfigSchema.parse({
        ...base,
        extensions: { memory: { unknown: 1 } },
      }),
    ).toThrow();
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

    expect(config.get().extensions.memory.episodes).toEqual({
      maxCharacters: 50_000,
      maxDurationMs: 3_600_000,
      idleTimeoutMs: 300_000,
    });
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
      schemaVersion: 8,
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

  it('resolves GPT-Live with Responses delegation options', async () => {
    const config = createConfig({
      logging,
      dataDirectory: await directory(true),
      env: { REALTIME_KEY: 'sk-live' },
    });
    await config.start();
    await config.writeProviderInstance('openai-voice', {
      type: 'openai',
      settings: {
        apiKey: '${env:REALTIME_KEY}',
        baseUrl: 'https://openai.example/v1',
      },
      knownModels: {
        'gpt-live-1': {
          contextSize: 128_000,
          capabilities: { voice: { sts: true }, input: { audio: {} } },
        },
      },
    });
    await config.writeModelSelection({
      ...emptyModelSelection,
      voice: {
        ...emptyModelSelection.voice,
        sts: [
          {
            providerId: 'openai-voice',
            modelId: 'gpt-live-1',
            providerOptions: {
              openai: { live: { responsesModelId: 'gpt-5.6-terra' } },
            },
          },
        ],
      },
    });

    expect(config.resolveRealtimeProvider()).toMatchObject({
      kind: 'openai-live',
      model: { modelId: 'gpt-live-1', contextSize: 128_000 },
      config: {
        modelId: 'gpt-live-1',
        apiKey: 'sk-live',
        baseUrl: 'https://openai.example/v1',
        responsesModelId: 'gpt-5.6-terra',
      },
    });
    expect(config.resolveRealtimeProvider()?.model).not.toHaveProperty(
      'apiKey',
    );

    await config.writeModelSelection({
      ...emptyModelSelection,
      voice: {
        ...emptyModelSelection.voice,
        sts: [{ providerId: 'openai-voice', modelId: 'gpt-live-1' }],
      },
    });
    expect(config.resolveRealtimeProvider()).toMatchObject({
      kind: 'openai-live',
      config: { responsesModelId: 'gpt-5.6-luna' },
    });
    await config.writeProviderInstance('gemini-voice', {
      type: 'google-gemini',
      settings: { apiKey: 'sk-gemini-test' },
      knownModels: {
        'gemini-3.8-live': {
          displayName: 'Gemini 3.8 Live',
          contextSize: 131_072,
          capabilities: {
            voice: { sts: true },
          },
        },
      },
    });
    await config.writeModelSelection({
      ...emptyModelSelection,
      voice: {
        ...emptyModelSelection.voice,
        sts: [{ providerId: 'gemini-voice', modelId: 'gemini-3.8-live' }],
      },
    });
    expect(config.resolveRealtimeProvider()).toMatchObject({
      kind: 'gemini-live',
      model: {
        modelId: 'gemini-3.8-live',
        displayName: 'Gemini 3.8 Live',
        contextSize: 131_072,
      },
      config: {
        modelId: 'gemini-3.8-live',
        apiKey: 'sk-gemini-test',
        websocketUrl:
          'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=sk-gemini-test',
      },
    });
    await config.close();
  });

  it('rejects invalid GPT-Live Responses model options', async () => {
    const config = createConfig({
      logging,
      dataDirectory: await directory(true),
      env: {},
    });
    await config.start();
    await config.writeProviderInstance('openai-voice', {
      type: 'openai',
      settings: { apiKey: 'test-key' },
      knownModels: {
        'gpt-live-1': { capabilities: { voice: { sts: true } } },
      },
    });
    await config.writeModelSelection({
      ...emptyModelSelection,
      voice: {
        ...emptyModelSelection.voice,
        sts: [
          {
            providerId: 'openai-voice',
            modelId: 'gpt-live-1',
            providerOptions: {
              openai: { live: { responsesModelId: ' ' } },
            },
          },
        ],
      },
    });

    expect(() => config.resolveRealtimeProvider()).toThrow(
      'responsesModelId must be a non-empty string',
    );
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
