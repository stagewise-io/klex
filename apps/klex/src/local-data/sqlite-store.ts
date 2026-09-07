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

export interface SqliteStoreInspection {
  metadata: LocalDataMetadata;
  legacy: boolean;
}

export async function inspectSqliteStore(
  filePath: string,
  definition: SqliteStoreDefinition,
  dataDirectory: string,
): Promise<SqliteStoreInspection | undefined> {
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
    const legacy = !values.has(META_KEYS.store);
    let metadata: LocalDataMetadata;
    if (legacy) {
      if (definition.legacySchemaVersion === undefined)
        throw new Error(
          `SQLite local data store "${definition.id}" at "${filePath}" is unversioned and unsupported`,
        );
      const legacyVersion = await readLegacyVersion(client, definition.id);
      if (legacyVersion !== definition.legacySchemaVersion)
        throw new Error(
          `SQLite store "${definition.id}" has unsupported legacy schema ${legacyVersion}`,
        );
      metadata = {
        store: definition.id,
        schemaVersion: legacyVersion,
        compatibilityVersion: 1,
        minimumKlexVersion: definition.minimumKlexVersion,
        writtenByKlexVersion: 'legacy',
      };
    } else {
      metadata = {
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
    }
    assertCompatibleMetadata(dataDirectory, definition, metadata);
    if (metadata.schemaVersion === definition.schemaVersion)
      await definition.validate?.(client);
    return { metadata, legacy };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not inspect SQLite store "${definition.id}": ${detail}`,
      { cause: error },
    );
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
  needsAdoption = false,
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
    if (
      needsAdoption ||
      metadata.compatibilityVersion < definition.compatibilityVersion
    ) {
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
  const inspection = await inspectSqliteStore(
    filePath,
    definition,
    dataDirectory,
  );
  if (
    !inspection ||
    inspection.legacy ||
    inspection.metadata.schemaVersion !== definition.schemaVersion
  ) {
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

async function readLegacyVersion(
  client: Client,
  storeId: string,
): Promise<number> {
  const result = await client.execute({
    sql: 'SELECT value FROM meta WHERE key = ?',
    args: ['version'],
  });
  const raw = result.rows[0]?.value;
  const version = typeof raw === 'string' ? Number(raw) : Number.NaN;
  if (!Number.isInteger(version) || version < 1)
    throw new Error(
      `SQLite store "${storeId}" has invalid legacy meta.version`,
    );
  return version;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const details = await stat(filePath);
    if (!details.isFile())
      throw new Error(`SQLite store path "${filePath}" is not a regular file`);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return false;
    throw error;
  }
}
