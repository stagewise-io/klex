import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import type { RootLogger } from '@stagewise/logger';

import { createLocalData } from '@/local-data';
import { configV12Schema } from '@/local-data-migrations/config/v12-to-v13/v12';
import { configV13Schema } from '@/local-data-migrations/config/v12-to-v13/v13';

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
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function setup(bytes: string) {
  const directory = await mkdtemp(join(tmpdir(), 'klex-langdock-'));
  directories.push(directory);
  const path = join(directory, 'config.json');
  await writeFile(path, bytes);
  const start = async (store = CONFIG_STORE_DEFINITION) => {
    const localData = createLocalData({
      logging,
      dataDirectory: directory,
      klexVersion: '0.37.1',
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

it('migrates the frozen v12 payload unchanged through startup, and is idempotent', async () => {
  const original = JSON.parse(await fixture('config-v12-langdock-baseline'));
  const { _klex: _metadata, ...payload } = original;
  configV12Schema.parse(payload);
  const { directory, path, start } = await setup(JSON.stringify(original));
  await start();
  const bytes = await readFile(path, 'utf8');
  const migrated = JSON.parse(bytes);
  expect(migrated).toEqual({
    ...original,
    _klex: {
      ...original._klex,
      schemaVersion: CONFIG_STORE_DEFINITION.schemaVersion,
      minimumKlexVersion: '0.36.0',
      writtenByKlexVersion: '0.37.1',
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
  expect(config.get().modelSelection.chat[0]?.providerOptions).toEqual(
    original.modelSelection.chat[0].providerOptions,
  );
  await config.close();
  const beforeOlderReader = await readFile(path, 'utf8');
  await expect(
    start({
      ...CONFIG_STORE_DEFINITION,
      schemaVersion: 12,
      versions: CONFIG_STORE_DEFINITION.versions.filter(
        ({ version }) => version <= 12,
      ),
      migrations: CONFIG_STORE_DEFINITION.migrations.filter(
        ({ to }) => to <= 12,
      ),
    }),
  ).rejects.toThrow();
  expect(await readFile(path, 'utf8')).toBe(beforeOlderReader);
});

it('loads the frozen v13 Langdock config with environment references and selections intact', async () => {
  const bytes = await fixture('config-v13-langdock');
  const parsed = JSON.parse(bytes);
  const { _klex: _metadata, ...payload } = parsed;
  configV13Schema.parse(payload);
  expect(() => configV12Schema.parse(payload)).toThrow();
  const { directory, path, start } = await setup(bytes);
  await start();
  const config = createConfig({
    logging,
    dataDirectory: directory,
    env: {
      PRIMARY_API_KEY: 'synthetic',
      LANGDOCK_API_KEY: 'synthetic',
      TENANT: 'tenant',
    },
  });
  await config.start();
  expect(config.get().providers.langdock?.type).toBe('langdock');
  expect(config.get().modelSelection.chat).toEqual(parsed.modelSelection.chat);
  await config.close();
  const stored = JSON.parse(await readFile(path, 'utf8'));
  expect(stored).toEqual({
    ...parsed,
    _klex: {
      ...parsed._klex,
      schemaVersion: CONFIG_STORE_DEFINITION.schemaVersion,
      writtenByKlexVersion: stored._klex.writtenByKlexVersion,
    },
  });
});

it('restores failed v12 migration bytes and retries cleanly', async () => {
  const bytes = await fixture('config-v12-langdock-baseline');
  const { path, start } = await setup(bytes);
  await expect(
    start({
      ...CONFIG_STORE_DEFINITION,
      migrations: CONFIG_STORE_DEFINITION.migrations.map((step) =>
        step.from === 12
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
  expect(JSON.parse(await readFile(path, 'utf8'))._klex.schemaVersion).toBe(
    CONFIG_STORE_DEFINITION.schemaVersion,
  );
});

it.each(['invalid', 'newer'])(
  'rejects %s config without mutation',
  async (kind) => {
    const value = JSON.parse(await fixture('config-v12-langdock-baseline'));
    if (kind === 'newer')
      value._klex.schemaVersion = CONFIG_STORE_DEFINITION.schemaVersion + 1;
    else value.providers.primary.settings.apiKey = 42;
    const bytes = JSON.stringify(value);
    const { path, start } = await setup(bytes);
    await expect(start()).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe(bytes);
  },
);
