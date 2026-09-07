import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient } from '@libsql/client';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createLogger } from '@stagewise/logger';

import { pruneCheckpoints, restoreCheckpoint } from './checkpoint';
import { writeJsonStoreDocument } from './json-store';
import { createLocalData, validateLocalDataRegistry } from './local-data';
import type { JsonStoreDefinition, SqliteStoreDefinition } from './types';

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

  it('rejects newer data without mutating any registered store', async () => {
    const directory = await temporaryDirectory();
    const newerPath = join(directory, 'synthetic.json');
    const peerPath = join(directory, 'peer.json');
    const newer = `${JSON.stringify(document(3, { name: 'newer' }))}\n`;
    const peer = `${JSON.stringify({
      _klex: {
        store: 'peer',
        schemaVersion: 2,
        compatibilityVersion: 1,
        minimumKlexVersion: '2.0.0',
        writtenByKlexVersion: '2.0.0',
      },
      name: 'peer',
      count: 1,
    })}\n`;
    await writeFile(newerPath, newer);
    await writeFile(peerPath, peer);

    await expect(
      createLocalData({
        logging: logger,
        dataDirectory: directory,
        klexVersion: '2.1.0',
        stores: [
          definition(),
          definition({ id: 'peer', relativePath: 'peer.json' }),
        ],
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
    const migrationsPath = join(directory, '.klex-migrations');
    const journalPath = join(migrationsPath, 'journal.json');
    await expect(readFile(journalPath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const checkpointsPath = join(migrationsPath, 'checkpoints');
    const [checkpoint] = await readdir(checkpointsPath);
    const manifest = JSON.parse(
      await readFile(
        join(checkpointsPath, checkpoint as string, 'manifest.json'),
        'utf8',
      ),
    ) as { status: string };
    expect(manifest.status).toBe('failed');
  });

  it('adopts a valid legacy JSON store inside a checkpoint', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'synthetic.json');
    await writeFile(path, JSON.stringify({ name: 'legacy' }));
    const localData = createLocalData({
      logging: logger,
      dataDirectory: directory,
      klexVersion: '2.1.0',
      stores: [
        definition({
          schemaVersion: 1,
          versions: [{ version: 1, schema: schemaV1 }],
          migrations: [],
          legacySchemaVersion: 1,
        }),
      ],
    });

    await localData.start();

    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      name: 'legacy',
      _klex: {
        store: 'synthetic',
        schemaVersion: 1,
        writtenByKlexVersion: '2.1.0',
      },
    });
    const checkpointsPath = join(directory, '.klex-migrations', 'checkpoints');
    const [checkpoint] = await readdir(checkpointsPath);
    const manifest = JSON.parse(
      await readFile(
        join(checkpointsPath, checkpoint as string, 'manifest.json'),
        'utf8',
      ),
    ) as { status: string };
    expect(manifest.status).toBe('successful');
  });

  it('adopts a legacy SQLite store without losing rows', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'legacy.sqlite');
    const client = createClient({ url: `file:${path}` });
    await client.executeMultiple(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta (key, value) VALUES ('version', '1');
      CREATE TABLE records (value TEXT NOT NULL);
      INSERT INTO records (value) VALUES ('preserved');
    `);
    client.close();
    const sqliteDefinition: SqliteStoreDefinition = {
      kind: 'sqlite',
      id: 'legacy-sqlite',
      relativePath: 'legacy.sqlite',
      required: false,
      createIfMissing: false,
      schemaVersion: 1,
      compatibilityVersion: 1,
      minimumKlexVersion: '2.0.0',
      legacySchemaVersion: 1,
      initSql: '',
      migrations: [],
      validate: async (database) => {
        await database.execute('SELECT value FROM records LIMIT 1');
      },
    };

    await createLocalData({
      logging: logger,
      dataDirectory: directory,
      klexVersion: '2.1.0',
      stores: [sqliteDefinition],
    }).start();

    const verified = createClient({ url: `file:${path}` });
    expect(
      (await verified.execute('SELECT value FROM records')).rows[0]?.value,
    ).toBe('preserved');
    expect(
      (await verified.execute("SELECT value FROM meta WHERE key = 'store'"))
        .rows[0]?.value,
    ).toBe('legacy-sqlite');
    verified.close();
  });

  it('migrates SQLite before validating the current schema', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'migrating.sqlite');
    const client = createClient({ url: `file:${path}` });
    await client.executeMultiple(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta (key, value) VALUES
        ('store', 'migrating-sqlite'),
        ('schemaVersion', '1'),
        ('compatibilityVersion', '1'),
        ('minimumKlexVersion', '1.0.0'),
        ('writtenByKlexVersion', '1.0.0');
    `);
    client.close();
    const sqliteDefinition: SqliteStoreDefinition = {
      kind: 'sqlite',
      id: 'migrating-sqlite',
      relativePath: 'migrating.sqlite',
      required: false,
      createIfMissing: false,
      schemaVersion: 2,
      compatibilityVersion: 1,
      minimumKlexVersion: '2.0.0',
      initSql: '',
      migrations: [
        {
          from: 1,
          to: 2,
          name: 'add-records',
          up: async (database) => {
            await database.execute(
              'CREATE TABLE records (value TEXT NOT NULL)',
            );
          },
        },
      ],
      validate: async (database) => {
        await database.execute('SELECT value FROM records LIMIT 1');
      },
    };

    await createLocalData({
      logging: logger,
      dataDirectory: directory,
      klexVersion: '2.1.0',
      stores: [sqliteDefinition],
    }).start();

    const verified = createClient({ url: `file:${path}` });
    expect(
      (
        await verified.execute(
          "SELECT value FROM meta WHERE key = 'schemaVersion'",
        )
      ).rows[0]?.value,
    ).toBe('2');
    verified.close();
  });

  it('serializes concurrent startup calls and supports restart after close', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'synthetic.json');
    await writeFile(path, JSON.stringify(document(1, { name: 'agent' })));
    let migrations = 0;
    const localData = createLocalData({
      logging: logger,
      dataDirectory: directory,
      klexVersion: '2.1.0',
      stores: [
        definition({
          migrations: [
            {
              from: 1,
              to: 2,
              name: 'count-runs',
              up: async (value) => {
                migrations += 1;
                await new Promise((resolve) => setTimeout(resolve, 10));
                return { ...value, count: 0 };
              },
            },
          ],
        }),
      ],
    });

    await Promise.all([localData.start(), localData.start()]);
    await localData.close();
    await localData.start();

    expect(migrations).toBe(1);
  });

  it('rejects reserved metadata before schemas can strip it', async () => {
    const directory = await temporaryDirectory();
    await expect(
      writeJsonStoreDocument(
        join(directory, 'synthetic.json'),
        definition({
          versions: [
            { version: 1, schema: schemaV1 },
            {
              version: 2,
              schema: z.object({ name: z.string(), count: z.number() }),
            },
          ],
        }),
        { name: 'agent', count: 0, _klex: {} },
        '2.1.0',
      ),
    ).rejects.toThrow(/reserved "_klex"/);
  });

  it('rejects unsafe checkpoint identifiers and prunes abandoned staging directories', async () => {
    const directory = await temporaryDirectory();
    const staging = join(
      directory,
      '.klex-migrations',
      'checkpoints',
      'abandoned.tmp',
    );
    await mkdir(staging, { recursive: true });

    await expect(restoreCheckpoint(directory, '..')).rejects.toThrow(
      /Unsafe checkpoint path/,
    );
    await pruneCheckpoints(directory);
    await expect(stat(staging)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('surfaces malformed checkpoint manifests during pruning', async () => {
    const directory = await temporaryDirectory();
    const checkpoint = join(
      directory,
      '.klex-migrations',
      'checkpoints',
      'malformed',
    );
    await mkdir(checkpoint, { recursive: true });
    await writeFile(join(checkpoint, 'manifest.json'), '{');

    await expect(pruneCheckpoints(directory)).rejects.toThrow();
  });

  it.skipIf(process.platform === 'win32')(
    'rejects store paths that traverse symlinks during checkpointing',
    async () => {
      const directory = await temporaryDirectory();
      const outside = await temporaryDirectory();
      const outsidePath = join(outside, 'synthetic.json');
      const original = `${JSON.stringify(document(1, { name: 'outside' }))}\n`;
      await writeFile(outsidePath, original);
      await symlink(outsidePath, join(directory, 'synthetic.json'));

      await expect(
        createLocalData({
          logging: logger,
          dataDirectory: directory,
          klexVersion: '2.1.0',
          stores: [definition()],
        }).start(),
      ).rejects.toMatchObject({
        cause: expect.objectContaining({
          message: expect.stringMatching(/symlink/),
        }),
      });
      expect(await readFile(outsidePath, 'utf8')).toBe(original);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rejects dangling store symlinks before SQLite initialization',
    async () => {
      const directory = await temporaryDirectory();
      const outside = await temporaryDirectory();
      const outsidePath = join(outside, 'synthetic.db');
      await symlink(outsidePath, join(directory, 'synthetic.db'));
      const sqliteDefinition: SqliteStoreDefinition = {
        id: 'synthetic',
        kind: 'sqlite',
        relativePath: 'synthetic.db',
        required: true,
        createIfMissing: true,
        schemaVersion: 1,
        compatibilityVersion: 1,
        minimumKlexVersion: '2.0.0',
        initSql: 'CREATE TABLE synthetic (id TEXT PRIMARY KEY)',
        migrations: [],
      };

      await expect(
        createLocalData({
          logging: logger,
          dataDirectory: directory,
          klexVersion: '2.1.0',
          stores: [sqliteDefinition],
        }).start(),
      ).rejects.toMatchObject({
        cause: expect.objectContaining({
          message: expect.stringMatching(/symlink/),
        }),
      });
      await expect(stat(outsidePath)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('rejects equivalent paths, root paths, and incomplete migration chains', () => {
    expect(() =>
      validateLocalDataRegistry([
        definition({
          schemaVersion: 1,
          migrations: [],
          versions: [{ version: 1, schema: schemaV1 }],
        }),
        definition({
          id: 'peer',
          relativePath: './synthetic.json',
          schemaVersion: 1,
          migrations: [],
          versions: [{ version: 1, schema: schemaV1 }],
        }),
      ]),
    ).toThrow(/Duplicate local-data store path/);
    expect(() =>
      validateLocalDataRegistry([
        definition({ relativePath: 'nested/../../escaped.json' }),
      ]),
    ).toThrow(/Unsafe local-data store path/);
    expect(() =>
      validateLocalDataRegistry([
        definition({ relativePath: 'C:/escaped.json' }),
      ]),
    ).toThrow(/Unsafe local-data store path/);
    expect(() =>
      validateLocalDataRegistry([
        definition({
          relativePath: '.',
          schemaVersion: 1,
          migrations: [],
          versions: [{ version: 1, schema: schemaV1 }],
        }),
      ]),
    ).toThrow(/Unsafe local-data store path/);
    expect(() =>
      validateLocalDataRegistry([
        definition({
          schemaVersion: 3,
          versions: [
            { version: 2, schema: schemaV2 },
            { version: 3, schema: schemaV2 },
          ],
          migrations: [{ from: 2, to: 3, name: 'gap', up: (value) => value }],
        }),
      ]),
    ).toThrow(/must start at schema 1/);
  });
});
