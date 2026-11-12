import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { RootLogger } from '@stagewise/logger';

import { createLocalData } from '@/local-data';

import { createConfig } from './config';
import { parseKlexConfig } from './schema';
import { CONFIG_STORE_DEFINITION } from './storage-definition';

const dirs: string[] = [];
const logging = {
  child: () => ({ info() {}, warn() {}, error() {} }),
} as unknown as RootLogger;
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('effort config forward migration', () => {
  it('keeps absent defaults absent and rejects inverted bounds', () => {
    expect(parseKlexConfig({}).effort).toBeUndefined();
    expect(parseKlexConfig({ effort: {} }).effort).toEqual({
      mode: 'off',
      floor: 'low',
      ceiling: 'high',
    });
    expect(() =>
      parseKlexConfig({ effort: { floor: 'high', ceiling: 'low' } }),
    ).toThrow();
  });
  it('migrates released v8 through registered startup, preserves payload, blocks older readers and is idempotent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'klex-effort-config-'));
    dirs.push(dir);
    const file = join(dir, 'config.json');
    const original = JSON.parse(
      await readFile(
        new URL(
          '../local-data-migration-fixtures/config-v8.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    await writeFile(file, JSON.stringify(original));
    const start = async () => {
      const local = createLocalData({
        logging,
        dataDirectory: dir,
        klexVersion: '0.31.1',
        stores: [CONFIG_STORE_DEFINITION],
      });
      await local.start();
      await local.close();
    };
    await start();
    const migrated = JSON.parse(await readFile(file, 'utf8'));
    expect({ ...migrated, _klex: undefined }).toEqual({
      ...original,
      _klex: undefined,
    });
    expect(migrated._klex.schemaVersion).toBe(10);
    const config = createConfig({
      logging,
      dataDirectory: dir,
      env: { PRIMARY_API_KEY: 'fixture' },
    });
    await config.start();
    await config.mutate((current) => ({
      ...current,
      effort: { mode: 'shadow', floor: 'low', ceiling: 'high' },
    }));
    await config.close();
    const before = await readFile(file, 'utf8');
    await start();
    expect(await readFile(file, 'utf8')).toBe(before);
    await expect(
      createLocalData({
        logging,
        dataDirectory: dir,
        klexVersion: '0.31.0',
        stores: [
          {
            ...CONFIG_STORE_DEFINITION,
            schemaVersion: 9,
            versions: CONFIG_STORE_DEFINITION.versions.filter(
              (entry) => entry.version <= 9,
            ),
            migrations: CONFIG_STORE_DEFINITION.migrations.filter(
              (entry) => entry.to <= 9,
            ),
          },
        ],
      }).start(),
    ).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe(before);
  });
});
