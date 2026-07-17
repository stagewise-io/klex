import type { Client } from '@libsql/client';
import { eq } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import {
  type MigrateDatabaseArgs,
  type MigrationScript,
  metaTable,
  type SchemaWithMeta,
} from './types';

export {
  type MigrateDatabaseArgs,
  type MigrationScript,
  metaTable,
  type SchemaWithMeta,
} from './types';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run database initialization or migrations.
 *
 * - Fresh DB: executes `initSql` via client.executeMultiple() and sets
 *   meta.version = schemaVersion.
 * - Existing DB: applies pending MigrationScript entries in version order,
 *   each inside its own transaction.
 *
 * Safe to call on every service start — idempotent.
 */
export async function migrateDatabase(
  args: MigrateDatabaseArgs,
): Promise<void> {
  const { db, client, registry, initSql, schemaVersion } = args;

  if (await isFresh(db)) {
    await install(db, client, initSql, schemaVersion);
  } else {
    await applyMigrations(db, registry);
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function isFresh(db: LibSQLDatabase<SchemaWithMeta>): Promise<boolean> {
  try {
    const rows = await db.select().from(metaTable);
    return rows.length === 0;
  } catch {
    // meta table doesn't exist → fresh
    return true;
  }
}

async function install(
  db: LibSQLDatabase<SchemaWithMeta>,
  client: Client,
  initSql: string,
  schemaVersion: number,
): Promise<void> {
  // executeMultiple is required — Drizzle's db.run() only executes the first
  // statement in a multi-statement SQL string.
  await client.executeMultiple(initSql);
  await db.insert(metaTable).values({
    key: 'version',
    value: String(schemaVersion),
  });
}

async function applyMigrations(
  db: LibSQLDatabase<SchemaWithMeta>,
  registry: MigrationScript[],
): Promise<void> {
  const versionRow = await db
    .select({ value: metaTable.value })
    .from(metaTable)
    .where(eq(metaTable.key, 'version'))
    .get();

  const currentVersion = versionRow ? Number.parseInt(versionRow.value, 10) : 0;

  const pending = registry
    .filter((m) => m.version > currentVersion)
    .sort((a, b) => a.version - b.version);

  for (const migration of pending) {
    await db.transaction(async (tx) => {
      await migration.up(tx);
      await tx
        .update(metaTable)
        .set({ value: String(migration.version) })
        .where(eq(metaTable.key, 'version'));
    });
  }
}
