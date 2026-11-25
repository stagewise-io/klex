import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import type { RootLogger } from '@stagewise/logger';

import { createLocalData } from '@/local-data';
import { configV13Schema } from '@/local-data-migrations/config/v13-to-v14/v13';
import { configV14Schema } from '@/local-data-migrations/config/v13-to-v14/v14';

import { createConfig } from './config';
import { CONFIG_STORE_DEFINITION } from './storage-definition';

const directories: string[] = [];
const logging = {
  child: () => ({ error() {}, info() {}, warn() {} }),
} as unknown as RootLogger;
const fixture = (name: string) =>
  readFile(
    new URL(`../local-data-migration-fixtures/${name}.json`, import.meta.url),
    'utf8',
  );
const olderReader = {
  ...CONFIG_STORE_DEFINITION,
  schemaVersion: 13,
  versions: CONFIG_STORE_DEFINITION.versions.filter(
    ({ version }) => version <= 13,
  ),
  migrations: CONFIG_STORE_DEFINITION.migrations.filter(({ to }) => to <= 13),
};
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function setup(bytes: string) {
  const directory = await mkdtemp(join(tmpdir(), 'klex-cloud-'));
  directories.push(directory);
  const path = join(directory, 'config.json');
  await writeFile(path, bytes);
  const start = async (store = CONFIG_STORE_DEFINITION) => {
    const localData = createLocalData({
      logging,
      dataDirectory: directory,
      klexVersion: '0.38.2',
      stores: [store],
    });
    try {
      await localData.start();
    } finally {
      await localData.close();
    }
  };
  return { directory, path, start };
}

it('migrates the frozen v13 managed payload unchanged through startup, and is idempotent', async () => {
  const original = JSON.parse(await fixture('config-v13-managed-baseline'));
  const { _klex: _metadata, ...payload } = original;
  configV13Schema.parse(payload);
  const { directory, path, start } = await setup(JSON.stringify(original));
  await start();
  const bytes = await readFile(path, 'utf8');
  const migrated = JSON.parse(bytes);
  expect(migrated).toEqual({
    ...original,
    _klex: {
      ...original._klex,
      schemaVersion: 14,
      minimumKlexVersion: '0.36.0',
      writtenByKlexVersion: '0.38.2',
    },
  });
  const before = (await stat(path)).mtimeMs;
  await start();
  expect(await readFile(path, 'utf8')).toBe(bytes);
  expect((await stat(path)).mtimeMs).toBe(before);
  const config = createConfig({
    logging,
    dataDirectory: directory,
    env: { PRIMARY_API_KEY: 'synthetic' },
  });
  await config.start();
  expect(config.get().providers['stagewise-managed-openai']?.type).toBe(
    'responses',
  );
  expect(config.get().modelSelection).toEqual(original.modelSelection);
  await config.close();
  const beforeOlderReader = await readFile(path, 'utf8');
  await expect(start(olderReader)).rejects.toThrow();
  expect(await readFile(path, 'utf8')).toBe(beforeOlderReader);
});

it('loads the frozen v14 Klex Cloud config with reserved realtime fields and environment references intact', async () => {
  const bytes = await fixture('config-v14-klex-cloud');
  const parsed = JSON.parse(bytes);
  const { _klex: _metadata, ...payload } = parsed;
  configV14Schema.parse(payload);
  expect(() => configV13Schema.parse(payload)).toThrow();
  const { directory, path, start } = await setup(bytes);
  await start();
  expect(await readFile(path, 'utf8')).toBe(bytes);
  const config = createConfig({
    logging,
    dataDirectory: directory,
    env: { PRIMARY_API_KEY: 'synthetic', KLEX_CLOUD_TOKEN: 'sk_sw_synthetic' },
  });
  await config.start();
  const provider = config.get().providers['stagewise-managed-cloud'];
  expect(provider?.type).toBe('klex-cloud');
  expect(provider?.settings).toMatchObject({
    protocols: { 'openai/gpt-live-1': 'openai-live' },
    realtimeBaseUrl: 'wss://gateway.example/v1/realtime',
  });
  expect(config.get().modelSelection.chat).toEqual(parsed.modelSelection.chat);
  await config.close();
  const stored = JSON.parse(await readFile(path, 'utf8'));
  expect(stored).toEqual({
    ...parsed,
    _klex: {
      ...parsed._klex,
      writtenByKlexVersion: stored._klex.writtenByKlexVersion,
    },
  });
  const beforeOlderReader = await readFile(path, 'utf8');
  await expect(start(olderReader)).rejects.toThrow();
  expect(await readFile(path, 'utf8')).toBe(beforeOlderReader);
});

it('restores failed v13 migration bytes and retries cleanly', async () => {
  const bytes = await fixture('config-v13-managed-baseline');
  const { path, start } = await setup(bytes);
  await expect(
    start({
      ...CONFIG_STORE_DEFINITION,
      migrations: CONFIG_STORE_DEFINITION.migrations.map((step) =>
        step.from === 13
          ? {
              ...step,
              up: () => {
                throw new Error('injected');
              },
            }
          : step,
      ),
    }),
  ).rejects.toThrow(/restored/);
  expect(await readFile(path, 'utf8')).toBe(bytes);
  await start();
  expect(JSON.parse(await readFile(path, 'utf8'))._klex.schemaVersion).toBe(14);
});

it.each(['invalid', 'newer', 'klex-cloud-in-v13'])(
  'rejects %s config without mutation',
  async (kind) => {
    const value = JSON.parse(await fixture('config-v13-managed-baseline'));
    if (kind === 'newer')
      value._klex.schemaVersion = CONFIG_STORE_DEFINITION.schemaVersion + 1;
    else if (kind === 'invalid')
      value.providers['stagewise-managed-openai'].settings.apiKey = 42;
    else
      value.providers.cloud = {
        type: 'klex-cloud',
        settings: { baseUrl: 'https://gateway.example/v1', apiKey: 'key' },
      };
    const bytes = JSON.stringify(value);
    const { path, start } = await setup(bytes);
    await expect(start()).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe(bytes);
  },
);

it.each([
  ['environment base URL', { baseUrl: '${env:GATEWAY_URL}', apiKey: 'key' }],
  [
    'unknown protocol',
    {
      baseUrl: 'https://gateway.example/v1',
      apiKey: 'key',
      protocols: { model: 'google' },
    },
  ],
])('frozen v14 rejects %s', (_name, settings) => {
  const valid = {
    configVersion: 2,
    providers: {
      cloud: {
        type: 'klex-cloud',
        settings: { baseUrl: 'https://gateway.example/v1', apiKey: 'key' },
      },
    },
  };
  configV14Schema.parse(valid);
  expect(() =>
    configV14Schema.parse({
      ...valid,
      providers: { cloud: { type: 'klex-cloud', settings } },
    }),
  ).toThrow();
});
