import type { Client, ResultSet } from '@libsql/client';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import type { ExtractTablesWithRelations } from 'drizzle-orm/relations';
import {
  type SQLiteTransaction,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';

// ---------------------------------------------------------------------------
// Meta table — one row per database, tracks schema version.
// Every service's Drizzle schema must include this table.
// ---------------------------------------------------------------------------

export const metaTable = sqliteTable('meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Context passed to MigrationScript.up() — accepts both a raw DB and a transaction. */
type MigrationContext =
  | LibSQLDatabase<SchemaWithMeta>
  | SQLiteTransaction<
      'async',
      ResultSet,
      SchemaWithMeta,
      ExtractTablesWithRelations<SchemaWithMeta>
    >;

/**
 * Schema shape every service must adopt.
 * Extend with your own tables, e.g.:
 *   type MySchema = SchemaWithMeta & { sessions: typeof sessionsTable };
 */
export type SchemaWithMeta = {
  meta: typeof metaTable;
  [key: string]: unknown;
};

/** A single versioned migration. */
export type MigrationScript = {
  version: number;
  name: string;
  up: (db: MigrationContext) => Promise<void>;
};

/** Arguments for migrateDatabase(). */
export type MigrateDatabaseArgs = {
  /** Drizzle database instance with your schema */
  db: LibSQLDatabase<SchemaWithMeta>;
  /** Raw libsql client — required for multi-statement initSql */
  client: Client;
  /** Ordered list of migration scripts */
  registry: MigrationScript[];
  /** Multi-statement SQL for fresh database initialization */
  initSql: string;
  /** Latest schema version — set as meta.version after fresh install */
  schemaVersion: number;
};
