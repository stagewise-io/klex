import { stat } from 'node:fs/promises';

import { type Client, createClient } from '@libsql/client';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { assertCompatibleMetadata } from './metadata';
import type { LocalDataMetadata, SqliteStoreDefinition } from './types';

export const localDataMetaTable = sqliteTable('meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

const META_KEYS = {
  store: 'store',
  schemaVersion: 'schemaVersion',
  compatibilityVersion: 'compatibilityVersion',
  minimumKlexVersion: 'minimumKlexVersion',
  writtenByKlexVersion: 'writtenByKlexVersion',
} as const;

export async function inspectSqliteStore(
  filePath: string,
  definition: SqliteStoreDefinition,
  dataDirectory: string,
): Promise<LocalDataMetadata | undefined> {
  if (!(await fileExists(filePath))) return undefined;
  const client = createClient({ url: `file:${filePath}` });
  try {
    const table = await client.execute({
      sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'",
      args: [],
    });
    if (table.rows.length === 0) {
      throw new Error(
        `SQLite local data store "${definition.id}" at "${filePath}" is unversioned and unsupported`,
      );
    }
    const result = await client.execute(
      'SELECT key, value FROM meta WHERE key IN (?, ?, ?, ?, ?)',
      Object.values(META_KEYS),
    );
    const values = new Map<string, string>();
    for (const row of result.rows) {
      const key = row.key;
      const value = row.value;
      if (typeof key === 'string' && typeof value === 'string')
        values.set(key, value);
    }
    const metadata: LocalDataMetadata = {
      store: requiredMeta(values, META_KEYS.store, definition.id),
      schemaVersion: positiveIntegerMeta(
        values,
        META_KEYS.schemaVersion,
        definition.id,
      ),
      compatibilityVersion: positiveIntegerMeta(
        values,
        META_KEYS.compatibilityVersion,
        definition.id,
      ),
      minimumKlexVersion: requiredMeta(
        values,
        META_KEYS.minimumKlexVersion,
        definition.id,
      ),
      writtenByKlexVersion: requiredMeta(
        values,
        META_KEYS.writtenByKlexVersion,
        definition.id,
      ),
    };
    assertCompatibleMetadata(dataDirectory, definition, metadata);
    return metadata;
  } catch (error) {
    throw new Error(`Could not inspect SQLite store "${definition.id}"`, {
      cause: error,
    });
  } finally {
    client.close();
  }
}

export async function initializeSqliteStore(
  filePath: string,
  definition: SqliteStoreDefinition,
  klexVersion: string,
): Promise<void> {
  const client = createClient({ url: `file:${filePath}` });
  try {
    await client.executeMultiple(definition.initSql);
    await writeSqliteMetadata(client, definition, klexVersion);
    await definition.validate?.(client);
  } finally {
    client.close();
  }
}

export async function migrateSqliteStore(
  filePath: string,
  definition: SqliteStoreDefinition,
  metadata: LocalDataMetadata,
  klexVersion: string,
): Promise<void> {
  const client = createClient({ url: `file:${filePath}` });
  try {
    let schemaVersion = metadata.schemaVersion;
    while (schemaVersion < definition.schemaVersion) {
      const migration = definition.migrations.find(
        (candidate) => candidate.from === schemaVersion,
      );
      if (!migration)
        throw new Error(
          `No migration for SQLite store "${definition.id}" from schema ${schemaVersion}`,
        );
      const transaction = await client.transaction('write');
      try {
        await migration.up(transaction);
        schemaVersion = migration.to;
        await writeSqliteMetadata(
          transaction,
          definition,
          klexVersion,
          schemaVersion,
        );
        await transaction.commit();
      } catch (error) {
        await transaction.rollback().catch(() => undefined);
        throw new Error(
          `SQLite migration "${migration.name}" failed for store "${definition.id}"`,
          { cause: error },
        );
      }
    }
    if (metadata.compatibilityVersion < definition.compatibilityVersion) {
      await writeSqliteMetadata(client, definition, klexVersion);
    }
    await definition.validate?.(client);
  } finally {
    client.close();
  }
}

export async function assertCurrentSqliteStore(
  filePath: string,
  definition: SqliteStoreDefinition,
  dataDirectory: string,
): Promise<void> {
  const metadata = await inspectSqliteStore(
    filePath,
    definition,
    dataDirectory,
  );
  if (!metadata || metadata.schemaVersion !== definition.schemaVersion) {
    throw new Error(
      `SQLite store "${definition.id}" was not prepared by local-data startup`,
    );
  }
}

async function writeSqliteMetadata(
  client: Pick<Client, 'execute'>,
  definition: SqliteStoreDefinition,
  klexVersion: string,
  schemaVersion = definition.schemaVersion,
): Promise<void> {
  const values: Record<string, string> = {
    [META_KEYS.store]: definition.id,
    [META_KEYS.schemaVersion]: String(schemaVersion),
    [META_KEYS.compatibilityVersion]: String(definition.compatibilityVersion),
    [META_KEYS.minimumKlexVersion]: definition.minimumKlexVersion,
    [META_KEYS.writtenByKlexVersion]: klexVersion,
  };
  for (const [key, value] of Object.entries(values)) {
    await client.execute({
      sql: 'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      args: [key, value],
    });
  }
}

function requiredMeta(
  values: Map<string, string>,
  key: string,
  storeId: string,
): string {
  const value = values.get(key);
  if (!value)
    throw new Error(`SQLite store "${storeId}" is missing meta.${key}`);
  return value;
}

function positiveIntegerMeta(
  values: Map<string, string>,
  key: string,
  storeId: string,
): number {
  const raw = requiredMeta(values, key, storeId);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1)
    throw new Error(`SQLite store "${storeId}" has invalid meta.${key}`);
  return value;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return false;
    throw error;
  }
}
