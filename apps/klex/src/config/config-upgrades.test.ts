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

const fixtures = new URL('../local-data-history-fixtures/', import.meta.url);
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
      const { _klex: metadata, ...payload } = original;
      expect(metadata.schemaVersion).toBe(Number(version[1]));
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
          schemaVersion: 7,
          compatibilityVersion: 8,
          minimumKlexVersion: '0.27.1',
          writtenByKlexVersion: KLEX_VERSION,
        },
      });
      const beforeRestart = await snapshot(directory);
      // Include mtimes: even a byte-identical rewrite must fail this assertion.
      await start();
      expect(await snapshot(directory)).toEqual(beforeRestart);
    },
  );

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
