import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient } from '@libsql/client';
import { afterEach, describe, expect, it } from 'vitest';

import { initializeSqliteStore, inspectSqliteStore } from '@/local-data';

import { EPISODIC_SEARCH_INDEX_STORE_DEFINITION } from './search-index';

const directories: string[] = [];

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
        schemaVersion: 1,
        compatibilityVersion: 1,
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
      args: ['2', 'schemaVersion'],
    });
    client.close();

    await expect(
      inspectSqliteStore(
        file,
        EPISODIC_SEARCH_INDEX_STORE_DEFINITION,
        directory,
      ),
    ).rejects.toThrow(/schema=2/u);

    const verification = createClient({ url: `file:${file}` });
    const result = await verification.execute({
      sql: 'SELECT value FROM meta WHERE key = ?',
      args: ['schemaVersion'],
    });
    verification.close();
    expect(result.rows[0]?.value).toBe('2');
  });
});
