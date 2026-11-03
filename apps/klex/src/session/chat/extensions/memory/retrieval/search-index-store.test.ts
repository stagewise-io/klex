import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createClient } from '@libsql/client';
import { afterEach, describe, expect, it } from 'vitest';

import { createLogger } from '@stagewise/logger';

import {
  createLocalData,
  initializeSqliteStore,
  inspectSqliteStore,
  type SqliteStoreDefinition,
} from '@/local-data';

import { EPISODIC_SEARCH_INDEX_STORE_DEFINITION } from './search-index';

const directories: string[] = [];
const logging = createLogger({ name: 'canonical-search-upgrade' });
// Frozen v0.28.0 representation, deliberately independent of current initSql.
const released: SqliteStoreDefinition = {
  ...EPISODIC_SEARCH_INDEX_STORE_DEFINITION,
  schemaVersion: 1,
  compatibilityVersion: 1,
  minimumKlexVersion: '0.9.2',
  migrations: [],
  initSql: `
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE episodic_files (relative_file TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime_ms REAL NOT NULL);
    CREATE TABLE episodic_vocabulary (term TEXT PRIMARY KEY, frequency INTEGER NOT NULL);
    CREATE TABLE episodic_term_trigrams (trigram TEXT NOT NULL, term TEXT NOT NULL REFERENCES episodic_vocabulary(term) ON DELETE CASCADE, PRIMARY KEY (trigram, term));
    CREATE INDEX episodic_term_trigrams_lookup ON episodic_term_trigrams(trigram);
    CREATE TABLE episodic_file_terms (relative_file TEXT NOT NULL, term TEXT NOT NULL, frequency INTEGER NOT NULL, PRIMARY KEY(relative_file, term));
    CREATE VIRTUAL TABLE episodic_entries USING fts5(text, normalized_text UNINDEXED, relative_file UNINDEXED, entry_ordinal UNINDEXED, occurred_at UNINDEXED, tokenize = 'porter unicode61');
    INSERT INTO episodic_files VALUES ('2026-10-01/1-12-00.jsonl', 100, 1);
    INSERT INTO episodic_entries VALUES ('legacy-only secret', 'legacy-only secret', '2026-10-01/1-12-00.jsonl', 0, '2026-10-01T12:00:00Z');
  `,
  validate: async () => {},
};

async function releasedStore() {
  const { directory } = await fixturePath();
  const file = join(directory, released.relativePath);
  await mkdir(dirname(file), { recursive: true });
  await initializeSqliteStore(file, released, '0.28.0');
  return { directory, file };
}

async function startup(
  directory: string,
  store = EPISODIC_SEARCH_INDEX_STORE_DEFINITION,
) {
  const localData = createLocalData({
    logging,
    dataDirectory: directory,
    klexVersion: '0.28.1',
    stores: [store],
  });
  try {
    await localData.start();
  } finally {
    await localData.close();
  }
}

async function fixturePath(): Promise<{ directory: string; file: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'klex-search-store-'));
  directories.push(directory);
  return { directory, file: join(directory, 'episodic-search.sqlite') };
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('episodic search index local-data store', () => {
  it('retires only the disposable corpus through registered startup and is restart-idempotent', async () => {
    const { directory, file } = await releasedStore();
    await startup(directory);
    const client = createClient({ url: `file:${file}` });
    try {
      expect(
        (
          await client.execute(
            "SELECT name FROM sqlite_master WHERE name LIKE 'episodic_%'",
          )
        ).rows,
      ).toEqual([]);
      expect(
        (await client.execute('SELECT * FROM activity_entries')).rows,
      ).toEqual([]);
      expect(
        (
          await inspectSqliteStore(
            file,
            EPISODIC_SEARCH_INDEX_STORE_DEFINITION,
            directory,
          )
        )?.metadata,
      ).toMatchObject({ schemaVersion: 2, compatibilityVersion: 2 });
    } finally {
      client.close();
    }
    const before = await readFile(file);
    await startup(directory);
    expect(await readFile(file)).toEqual(before);
    await expect(startup(directory, released)).rejects.toThrow(
      /newer Klex version/,
    );
    expect(await readFile(file)).toEqual(before);
  });

  it('restores the old corpus after a failed migration, then succeeds on retry', async () => {
    const { directory, file } = await releasedStore();
    const original = await readFile(file);
    const step = EPISODIC_SEARCH_INDEX_STORE_DEFINITION.migrations[0];
    if (!step) throw new Error('Search migration missing');
    const failing = {
      ...EPISODIC_SEARCH_INDEX_STORE_DEFINITION,
      migrations: [
        {
          ...step,
          up: async (...args: Parameters<typeof step.up>) => {
            await step.up(...args);
            throw new Error('injected migration failure');
          },
        },
      ],
    };
    await expect(startup(directory, failing)).rejects.toThrow();
    expect(await readFile(file)).toEqual(original);
    const client = createClient({ url: `file:${file}` });
    try {
      expect(
        (await client.execute('SELECT text FROM episodic_entries')).rows[0]
          ?.text,
      ).toBe('legacy-only secret');
      expect(
        (await inspectSqliteStore(file, released, directory))?.metadata
          .schemaVersion,
      ).toBe(1);
    } finally {
      client.close();
    }
    await startup(directory);
    expect(
      (
        await inspectSqliteStore(
          file,
          EPISODIC_SEARCH_INDEX_STORE_DEFINITION,
          directory,
        )
      )?.metadata.schemaVersion,
    ).toBe(2);
  });

  it('initializes and validates the current schema', async () => {
    const { directory, file } = await fixturePath();
    await initializeSqliteStore(
      file,
      EPISODIC_SEARCH_INDEX_STORE_DEFINITION,
      '0.9.2',
    );

    const inspection = await inspectSqliteStore(
      file,
      EPISODIC_SEARCH_INDEX_STORE_DEFINITION,
      directory,
    );

    expect(inspection).toMatchObject({
      legacy: false,
      metadata: {
        schemaVersion: 2,
        compatibilityVersion: 2,
        writtenByKlexVersion: '0.9.2',
      },
    });
  });

  it('rejects an unversioned file', async () => {
    const { directory, file } = await fixturePath();
    const client = createClient({ url: `file:${file}` });
    await client.executeMultiple(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta (key, value) VALUES ('version', '1');
    `);
    client.close();

    await expect(
      inspectSqliteStore(
        file,
        EPISODIC_SEARCH_INDEX_STORE_DEFINITION,
        directory,
      ),
    ).rejects.toThrow(/unversioned and unsupported/u);
  });

  it('rejects a newer schema without mutating it', async () => {
    const { directory, file } = await fixturePath();
    await initializeSqliteStore(
      file,
      EPISODIC_SEARCH_INDEX_STORE_DEFINITION,
      '0.9.2',
    );
    const client = createClient({ url: `file:${file}` });
    await client.execute({
      sql: 'UPDATE meta SET value = ? WHERE key = ?',
      args: ['3', 'schemaVersion'],
    });
    client.close();

    await expect(
      inspectSqliteStore(
        file,
        EPISODIC_SEARCH_INDEX_STORE_DEFINITION,
        directory,
      ),
    ).rejects.toThrow(/schema=3/u);

    const verification = createClient({ url: `file:${file}` });
    const result = await verification.execute({
      sql: 'SELECT value FROM meta WHERE key = ?',
      args: ['schemaVersion'],
    });
    verification.close();
    expect(result.rows[0]?.value).toBe('3');
  });
});
