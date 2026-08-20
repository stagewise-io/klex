import {
  index,
  integer,
  real,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';

import type { MigrationScript, metaTable } from '@/utils/sqlite';

/**
 * Drizzle schema for the model-call logger.
 *
 * One row per model call (chat generation or extension-initiated).
 * Time-range queries use `idx_model_calls_started_at`; split-by queries
 * use `idx_model_calls_split` on (provider_id, endpoint_id, model_id).
 */
export const modelCallsTable = sqliteTable(
  'model_calls',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id'),
    providerId: text('provider_id').notNull(),
    endpointId: text('endpoint_id'),
    modelId: text('model_id').notNull(),
    source: text('source').notNull(),
    extensionId: text('extension_id'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    inputCacheWriteTokens: integer('input_cache_write_tokens')
      .notNull()
      .default(0),
    inputCacheReadTokens: integer('input_cache_read_tokens')
      .notNull()
      .default(0),
    ttftMs: real('ttft_ms'),
    totalDurationMs: real('total_duration_ms'),
    finishReason: text('finish_reason').notNull(),
    isError: integer('is_error', { mode: 'boolean' }).notNull().default(false),
    errorType: text('error_type'),
    startedAt: text('started_at').notNull(),
    finishedAt: text('finished_at').notNull(),
  },
  (table) => [
    index('idx_model_calls_started_at').on(table.startedAt),
    index('idx_model_calls_split').on(
      table.providerId,
      table.endpointId,
      table.modelId,
    ),
  ],
);

/** Schema type with meta table required by migrateDatabase. */
export type ModelCallSchema = {
  meta: typeof metaTable;
  model_calls: typeof modelCallsTable;
};

/** Schema version — increment when adding migrations. */
export const MODEL_CALL_SCHEMA_VERSION = 1;

/** Empty migration registry — first version has no migrations. */
export const MODEL_CALL_MIGRATIONS: MigrationScript[] = [];

/**
 * Multi-statement SQL for fresh database initialization.
 * Creates the meta table, model_calls table, and indexes.
 */
export const MODEL_CALL_INIT_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS model_calls (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  provider_id TEXT NOT NULL,
  endpoint_id TEXT,
  model_id TEXT NOT NULL,
  source TEXT NOT NULL,
  extension_id TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  input_cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  input_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  ttft_ms REAL,
  total_duration_ms REAL,
  finish_reason TEXT NOT NULL,
  is_error INTEGER NOT NULL DEFAULT 0,
  error_type TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL
);

CREATE INDEX idx_model_calls_started_at ON model_calls (started_at);
CREATE INDEX idx_model_calls_split ON model_calls (provider_id, endpoint_id, model_id);
`;
