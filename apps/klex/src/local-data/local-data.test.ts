import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createLogger } from '@stagewise/logger';

import { createLocalData } from './local-data';
import type { JsonStoreDefinition } from './types';

const logger = createLogger({ name: 'local-data-test' });
const directories: string[] = [];

const schemaV1 = z.object({ name: z.string() }).passthrough();
const schemaV2 = z
  .object({ name: z.string(), count: z.number() })
  .passthrough();

function definition(
  overrides: Partial<JsonStoreDefinition> = {},
): JsonStoreDefinition {
  return {
    id: 'synthetic',
    kind: 'json',
    relativePath: 'synthetic.json',
    required: true,
    schemaVersion: 2,
    compatibilityVersion: 1,
    minimumKlexVersion: '2.0.0',
    versions: [
      { version: 1, schema: schemaV1 },
      { version: 2, schema: schemaV2 },
    ],
    migrations: [
      {
        from: 1,
        to: 2,
        name: 'add-count',
        up: (value) => ({ ...value, count: 0 }),
      },
    ],
    ...overrides,
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'klex-local-data-'));
  directories.push(directory);
  return directory;
}

function document(
  schemaVersion: number,
  payload: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    _klex: {
      store: 'synthetic',
      schemaVersion,
      compatibilityVersion: 1,
      minimumKlexVersion: schemaVersion === 1 ? '1.0.0' : '2.0.0',
      writtenByKlexVersion: schemaVersion === 1 ? '1.0.0' : '2.0.0',
      ...overrides,
    },
    ...payload,
  };
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

describe('LocalData', () => {
  it('migrates forward, preserves unknown fields, and is idempotent', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'synthetic.json');
    await writeFile(
      path,
      `${JSON.stringify(document(1, { name: 'agent', future: true }))}\n`,
    );

    const localData = createLocalData({
      logging: logger,
      dataDirectory: directory,
      klexVersion: '2.1.0',
      stores: [definition()],
    });
    await localData.start();
    await localData.start();

    const migrated = JSON.parse(await readFile(path, 'utf8')) as Record<
      string,
      unknown
    >;
    expect(migrated).toMatchObject({ name: 'agent', count: 0, future: true });
    expect(migrated._klex).toMatchObject({
      schemaVersion: 2,
      writtenByKlexVersion: '2.1.0',
      minimumKlexVersion: '2.0.0',
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('rejects newer data without mutating any store', async () => {
    const directory = await temporaryDirectory();
    const newerPath = join(directory, 'synthetic.json');
    const peerPath = join(directory, 'peer.json');
    const newer = `${JSON.stringify(document(3, { name: 'newer' }))}\n`;
    const peer = `${JSON.stringify({ marker: 'untouched' })}\n`;
    await writeFile(newerPath, newer);
    await writeFile(peerPath, peer);

    await expect(
      createLocalData({
        logging: logger,
        dataDirectory: directory,
        klexVersion: '2.1.0',
        stores: [definition()],
      }).start(),
    ).rejects.toThrow(/schema=3.*supports schema=2.*Use Klex 2\.0\.0 or newer/);
    expect(await readFile(newerPath, 'utf8')).toBe(newer);
    expect(await readFile(peerPath, 'utf8')).toBe(peer);
  });

  it.each([
    ['unversioned', { name: 'agent' }],
    ['wrong store', document(1, { name: 'agent' }, { store: 'other' })],
    [
      'malformed metadata',
      { ...document(1, { name: 'agent' }), _klex: { store: 'synthetic' } },
    ],
  ])('rejects %s data', async (_name, value) => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, 'synthetic.json'), JSON.stringify(value));
    await expect(
      createLocalData({
        logging: logger,
        dataDirectory: directory,
        klexVersion: '2.1.0',
        stores: [definition()],
      }).start(),
    ).rejects.toThrow();
  });

  it('restores the original file and retains a failed checkpoint when migration fails', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'synthetic.json');
    const original = `${JSON.stringify(document(1, { name: 'agent' }))}\n`;
    await writeFile(path, original);
    await chmod(path, 0o640);

    const failing = definition({
      migrations: [
        {
          from: 1,
          to: 2,
          name: 'fail-deliberately',
          up: () => {
            throw new Error('fault injection');
          },
        },
      ],
    });
    await expect(
      createLocalData({
        logging: logger,
        dataDirectory: directory,
        klexVersion: '2.1.0',
        stores: [failing],
      }).start(),
    ).rejects.toThrow(/original data was restored/);

    expect(await readFile(path, 'utf8')).toBe(original);
    expect((await stat(path)).mode & 0o777).toBe(0o640);
    const journalPath = join(directory, '.klex-migrations', 'journal.json');
    await expect(readFile(journalPath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
