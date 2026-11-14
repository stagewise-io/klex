import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { RootLogger } from '@stagewise/logger';

import { createLocalData } from '@/local-data';
import { KLEX_VERSION } from '@/release';

import { createConfig } from './config';
import { CONFIG_STORE_DEFINITION } from './storage-definition';

const fixtures = new URL('../local-data-migration-fixtures/', import.meta.url);
const directories: string[] = [];
const logging = {
  child: () => ({ error() {}, info() {}, warn() {} }),
} as unknown as RootLogger;
const cases = [
  'v1',
  'v2',
  'v3',
  'v4',
  'v5',
  'v6',
  'v6-empty',
  'v6-broken-0.27.0',
  'v7',
  'v8',
  'v9',
  'v10-effort',
];

async function snapshot(
  directory: string,
): Promise<Record<string, { bytes: string; mtime: number }>> {
  const files = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  const entries = await Promise.all(
    files
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const path = join(entry.parentPath, entry.name);
        return [
          path.slice(directory.length),
          {
            bytes: (await readFile(path)).toString('base64'),
            mtime: (await stat(path)).mtimeMs,
          },
        ] as const;
      }),
  );
  return Object.fromEntries(entries);
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('frozen persisted config upgrades', () => {
  it.each(
    cases.flatMap((version) =>
      version === 'v1'
        ? [
            { version, unversioned: false },
            { version, unversioned: true },
          ]
        : [{ version, unversioned: false }],
    ),
  )(
    'loads $version (unversioned: $unversioned) through registered startup without rewriting on restart',
    async ({ version, unversioned }) => {
      const directory = await mkdtemp(join(tmpdir(), 'klex-frozen-upgrade-'));
      directories.push(directory);
      const original = JSON.parse(
        await readFile(new URL(`config-${version}.json`, fixtures), 'utf8'),
      );
      const expected = JSON.parse(
        await readFile(new URL('config-expected-v7.json', fixtures), 'utf8'),
      );
      if (version === 'v10-effort')
        expected.effort = {
          mode: 'automatic',
          floor: 'medium',
          ceiling: 'high',
        };
      const { _klex: metadata, ...payload } = original;
      expect(metadata.schemaVersion).toBe(Number(/^v(\d+)/.exec(version)?.[1]));
      const historicalVersion = CONFIG_STORE_DEFINITION.versions.find(
        (item) => item.version === metadata.schemaVersion,
      );
      if (!historicalVersion)
        throw new Error(`Missing historical schema ${metadata.schemaVersion}`);
      expect(historicalVersion.schema.safeParse(payload).success).toBe(true);
      await writeFile(
        join(directory, 'config.json'),
        JSON.stringify(unversioned ? payload : original),
      );
      const start = async () => {
        const localData = createLocalData({
          logging,
          dataDirectory: directory,
          klexVersion: KLEX_VERSION,
          stores: [CONFIG_STORE_DEFINITION],
        });
        await localData.start();
        const config = createConfig({
          logging,
          dataDirectory: directory,
          env: { PRIMARY_API_KEY: 'fixture-key' },
        });
        await config.start();
        expect(config.get()).toEqual(expected);
        await config.close();
        await localData.close();
      };
      await start();
      const migrated = JSON.parse(
        await readFile(join(directory, 'config.json'), 'utf8'),
      );
      expect(migrated).toEqual({
        ...expected,
        _klex: {
          store: 'config',
          schemaVersion: 11,
          compatibilityVersion: 8,
          minimumKlexVersion: '0.33.0',
          writtenByKlexVersion: KLEX_VERSION,
        },
      });
      const beforeRestart = await snapshot(directory);
      // Include mtimes: even a byte-identical rewrite must fail this assertion.
      await start();
      expect(await snapshot(directory)).toEqual(beforeRestart);
    },
  );

  it('does not rewrite an already-current config in released key order on first startup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'klex-current-order-'));
    directories.push(directory);
    const expected = JSON.parse(
      await readFile(new URL('config-expected-v7.json', fixtures), 'utf8'),
    );
    const { _klex } = JSON.parse(
      await readFile(new URL('config-v11.json', fixtures), 'utf8'),
    );
    const { instincts, ...selections } = expected.modelSelection;
    // v0.27.1 inherited these positions from v5, then appended instinct.
    // Keep the order literal and independent of the live parser.
    const payload = {
      configVersion: expected.configVersion,
      officialName: expected.officialName,
      providers: expected.providers,
      modelSelection: { ...selections, instincts },
      mcpServers: expected.mcpServers,
      timezone: expected.timezone,
      extensions: expected.extensions,
      sessionHistory: { maxBytes: 32 * 1024 * 1024 },
      instinct: expected.instinct,
    };
    await writeFile(
      join(directory, 'config.json'),
      JSON.stringify(
        {
          ...payload,
          _klex: { ..._klex, schemaVersion: 11, minimumKlexVersion: '0.31.1' },
        },
        null,
        2,
      ),
    );
    const beforeStartup = await snapshot(directory);
    const localData = createLocalData({
      logging,
      dataDirectory: directory,
      klexVersion: KLEX_VERSION,
      stores: [CONFIG_STORE_DEFINITION],
    });
    await localData.start();
    const config = createConfig({
      logging,
      dataDirectory: directory,
      env: { PRIMARY_API_KEY: 'fixture-key' },
    });
    try {
      await config.start();
      expect(config.get()).toEqual(payload);
      expect(Object.keys(config.get())).toEqual(Object.keys(payload));
      expect(await snapshot(directory)).toEqual(beforeStartup);
    } finally {
      await config.close();
      await localData.close();
    }
  });

  it.each([5, 6])(
    'preserves released root key order in migration from v%i',
    async (version) => {
      const { _klex: _metadata, ...input } = JSON.parse(
        await readFile(new URL(`config-v${version}.json`, fixtures), 'utf8'),
      );
      const migration = CONFIG_STORE_DEFINITION.migrations.find(
        (step) => step.from === version,
      );
      if (!migration) throw new Error(`Missing migration from v${version}`);
      const output = await migration.up({
        ...input,
        sessionHistory: { maxBytes: 32 * 1024 * 1024 },
      });
      expect(Object.keys(output)).toEqual([
        'configVersion',
        'officialName',
        'providers',
        'modelSelection',
        'mcpServers',
        'timezone',
        'extensions',
        'sessionHistory',
        'instinct',
      ]);
    },
  );

  it('migrates v7 Codex local-CLI settings to v8 without rewriting them', async () => {
    const migration = CONFIG_STORE_DEFINITION.migrations.find(
      (step) => step.from === 7,
    );
    if (!migration) throw new Error('Missing 7→8 migration');
    const { _klex: _metadata, ...input } = JSON.parse(
      await readFile(new URL('config-v7.json', fixtures), 'utf8'),
    );
    const withCodex = {
      ...input,
      providers: {
        ...input.providers,
        codex: {
          type: 'chatgpt-codex-subscription',
          settings: { codexExecutable: '/usr/local/bin/codex' },
        },
      },
    };
    const output = await migration.up(structuredClone(withCodex));
    expect(output).toEqual(withCodex);
    expect(Object.keys(output)).toEqual(Object.keys(withCodex));
  });

  it('accepts managed Codex auth only from schema 8', () => {
    const settings = { authMode: 'managed' };
    const payload = {
      configVersion: 2,
      providers: {
        codex: { type: 'chatgpt-codex-subscription', settings },
      },
    };
    const schema = (version: number) => {
      const found = CONFIG_STORE_DEFINITION.versions.find(
        (item) => item.version === version,
      );
      if (!found) throw new Error(`Missing schema ${version}`);
      return found.schema;
    };
    expect(schema(7).safeParse(payload).success).toBe(false);
    expect(schema(8).safeParse(payload).success).toBe(true);
    expect(
      schema(8).safeParse({
        ...payload,
        providers: {
          codex: {
            type: 'chatgpt-codex-subscription',
            settings: { authMode: 'managed', codexExecutable: 'codex' },
          },
        },
      }).success,
    ).toBe(false);
  });

  it('migrates v8 provider entries to v9 without rewriting them', async () => {
    const migration = CONFIG_STORE_DEFINITION.migrations.find(
      (step) => step.from === 8,
    );
    if (!migration) throw new Error('Missing 8→9 migration');
    const { _klex: _metadata, ...input } = JSON.parse(
      await readFile(new URL('config-v8.json', fixtures), 'utf8'),
    );
    const withCodex = {
      ...input,
      providers: {
        ...input.providers,
        codex: {
          type: 'chatgpt-codex-subscription',
          settings: { authMode: 'managed' },
        },
      },
    };
    const output = await migration.up(structuredClone(withCodex));
    expect(output).toEqual(withCodex);
    expect(Object.keys(output)).toEqual(Object.keys(withCodex));
  });

  it('accepts a provider display name only from schema 9', () => {
    const payload = (displayName: unknown) => ({
      configVersion: 2,
      providers: {
        primary: { type: 'openai', displayName, settings: { apiKey: 'key' } },
      },
    });
    const schema = (version: number) => {
      const found = CONFIG_STORE_DEFINITION.versions.find(
        (item) => item.version === version,
      );
      if (!found) throw new Error(`Missing schema ${version}`);
      return found.schema;
    };
    expect(schema(8).safeParse(payload('Team OpenAI')).success).toBe(false);
    expect(schema(9).safeParse(payload('Team OpenAI')).success).toBe(true);
    for (const invalid of ['', ' padded ', 'x'.repeat(129), 42])
      expect(schema(9).safeParse(payload(invalid)).success).toBe(false);
  });

  it('loads a provider display name through registered startup and blocks older binaries', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'klex-display-name-'));
    directories.push(directory);
    const fixture = JSON.parse(
      await readFile(new URL('config-v11.json', fixtures), 'utf8'),
    );
    const original = {
      ...fixture,
      providers: {
        primary: { ...fixture.providers.primary, displayName: 'Team OpenAI' },
      },
    };
    const configPath = join(directory, 'config.json');
    await writeFile(configPath, JSON.stringify(original, null, 2));
    const start = async () => {
      const localData = createLocalData({
        logging,
        dataDirectory: directory,
        klexVersion: KLEX_VERSION,
        stores: [CONFIG_STORE_DEFINITION],
      });
      await localData.start();
      const config = createConfig({
        logging,
        dataDirectory: directory,
        env: { PRIMARY_API_KEY: 'fixture-key' },
      });
      await config.start();
      expect(config.get().providers.primary).toEqual(
        original.providers.primary,
      );
      await config.close();
      await localData.close();
    };
    await start();
    const { _klex, ...persisted } = JSON.parse(
      await readFile(configPath, 'utf8'),
    );
    const { _klex: _originalMetadata, ...originalPayload } = original;
    expect(persisted).toEqual(originalPayload);
    expect(_klex).toMatchObject({
      schemaVersion: 11,
      minimumKlexVersion: '0.33.0',
    });
    const beforeStartup = await snapshot(directory);
    await start();
    expect(await snapshot(directory)).toEqual(beforeStartup);

    await expect(
      createLocalData({
        logging,
        dataDirectory: directory,
        klexVersion: '0.30.1',
        stores: [
          {
            ...CONFIG_STORE_DEFINITION,
            schemaVersion: 8,
            minimumKlexVersion: '0.28.3',
            versions: CONFIG_STORE_DEFINITION.versions.filter(
              ({ version }) => version <= 8,
            ),
            migrations: CONFIG_STORE_DEFINITION.migrations.filter(
              ({ to }) => to <= 8,
            ),
          },
        ],
      }).start(),
    ).rejects.toThrow(/schema|newer/i);
    expect(await snapshot(directory)).toEqual(beforeStartup);
  });

  it('restores a v8 config after a failed 8→9 migration and retries successfully', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'klex-v9-failure-'));
    directories.push(directory);
    const original = await readFile(
      new URL('config-v8.json', fixtures),
      'utf8',
    );
    const configPath = join(directory, 'config.json');
    await writeFile(configPath, original);
    const start = async (definition: typeof CONFIG_STORE_DEFINITION) => {
      const localData = createLocalData({
        logging,
        dataDirectory: directory,
        klexVersion: KLEX_VERSION,
        stores: [definition],
      });
      try {
        await localData.start();
      } finally {
        await localData.close();
      }
    };
    await expect(
      start({
        ...CONFIG_STORE_DEFINITION,
        migrations: CONFIG_STORE_DEFINITION.migrations.map((step) =>
          step.from === 8
            ? {
                ...step,
                up: () => {
                  throw new Error('injected display-name migration failure');
                },
              }
            : step,
        ),
      }),
    ).rejects.toThrow(/original data was restored/);
    expect(await readFile(configPath, 'utf8')).toBe(original);
    await start(CONFIG_STORE_DEFINITION);
    const { _klex: _before, ...payload } = JSON.parse(original);
    const { _klex, ...migrated } = JSON.parse(
      await readFile(configPath, 'utf8'),
    );
    expect(migrated).toEqual(payload);
    expect(_klex).toMatchObject({
      schemaVersion: 11,
      minimumKlexVersion: '0.33.0',
    });
  });

  it('migrates v10 MCP servers to v11 without rewriting them', async () => {
    const migration = CONFIG_STORE_DEFINITION.migrations.find(
      (step) => step.from === 10,
    );
    if (!migration) throw new Error('Missing 10→11 migration');
    const { _klex: _metadata, ...input } = JSON.parse(
      await readFile(new URL('config-v10-effort.json', fixtures), 'utf8'),
    );
    const output = await migration.up(structuredClone(input));
    expect(output).toEqual(input);
    expect(Object.keys(output)).toEqual(Object.keys(input));
  });

  it('accepts MCP event subscriptions only from schema 11', () => {
    const payload = (events: unknown) => ({
      configVersion: 2,
      mcpServers: { chat: { command: 'chat-mcp', events } },
    });
    const schema = (version: number) => {
      const found = CONFIG_STORE_DEFINITION.versions.find(
        (item) => item.version === version,
      );
      if (!found) throw new Error(`Missing schema ${version}`);
      return found.schema;
    };
    const valid = [
      { name: 'incident.opened', arguments: { service: 'api' } },
      { name: 'deploy.finished', delivery: 'poll' },
    ];
    expect(schema(10).safeParse(payload(valid)).success).toBe(false);
    expect(schema(11).safeParse(payload(valid)).success).toBe(true);
    expect(schema(11).safeParse(payload([])).success).toBe(true);
    for (const invalid of [
      [{ name: '' }],
      [{ name: 'x', delivery: 'webhook' }],
      [{ name: 'x', extra: true }],
      'incident.opened',
    ])
      expect(schema(11).safeParse(payload(invalid)).success).toBe(false);
  });

  it('preserves a v11 config with event subscriptions on restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'klex-v10-events-'));
    directories.push(directory);
    const original = await readFile(
      new URL('config-v11.json', fixtures),
      'utf8',
    );
    const configPath = join(directory, 'config.json');
    await writeFile(configPath, original);
    const start = async () => {
      const localData = createLocalData({
        logging,
        dataDirectory: directory,
        klexVersion: KLEX_VERSION,
        stores: [CONFIG_STORE_DEFINITION],
      });
      await localData.start();
      const config = createConfig({
        logging,
        dataDirectory: directory,
        env: { PRIMARY_API_KEY: 'fixture-key' },
      });
      await config.start();
      expect(config.getMcpServers()['workspace']).toMatchObject({
        events: JSON.parse(original).mcpServers.workspace.events,
      });
      await config.close();
      await localData.close();
    };
    await start();
    const beforeRestart = await snapshot(directory);
    await start();
    expect(await snapshot(directory)).toEqual(beforeRestart);
    // Startup restamps only `_klex`; the payload, including events, is intact.
    const { _klex: _before, ...expectedPayload } = JSON.parse(original);
    const { _klex, ...persistedPayload } = JSON.parse(
      await readFile(configPath, 'utf8'),
    );
    expect(persistedPayload).toEqual(expectedPayload);
    expect(_klex).toMatchObject({ schemaVersion: 11 });
  });

  it('keeps the released 5→6 output voice lists; only 6→7 removes them', async () => {
    const { _klex: _metadata, ...input } = JSON.parse(
      await readFile(new URL('config-v5.json', fixtures), 'utf8'),
    );
    const migration = CONFIG_STORE_DEFINITION.migrations.find(
      (step) => step.from === 5,
    );
    if (!migration) throw new Error('Missing released 5→6 migration');
    const output = await migration.up(input);
    expect(output.modelSelection).toEqual({
      ...input.modelSelection,
      instincts: [],
    });
    expect(
      (output.modelSelection as typeof input.modelSelection).voice.tts,
    ).toHaveLength(1);
    expect(
      (output.modelSelection as typeof input.modelSelection).voice.stt,
    ).toHaveLength(1);
  });
});
