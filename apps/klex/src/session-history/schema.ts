import type { SqliteStoreDefinition } from '@/local-data';
import { LOCAL_DATA_MIGRATIONS } from '@/local-data-migrations';

/** Schema version — increment when adding migrations. */
export const SESSION_HISTORY_SCHEMA_VERSION = 3;

/** Relative path of the session-history database inside the data directory. */
export const SESSION_HISTORY_RELATIVE_PATH = 'sessions.sqlite';

/** Data-part type of a checkpoint header (`data-${CONTEXT_SUMMARY_KEY}`). */
export const CHECKPOINT_PART_TYPE = 'data-context-summary';

/**
 * Multi-statement SQL for fresh database initialization.
 *
 * `sessions` holds one row per `ChatSession` instance. `messages` is the
 * append-only log of each logical session (`session_id`), ordered by `ord`,
 * which is unique and monotonic per `session_id` across instances. Rows keep
 * the writing `instance_id` for per-instance reads. Checkpoint headers are
 * rows with `is_checkpoint = 1`; they replace every non-checkpoint row with
 * `ord <= covers_through_ord` in the restored window. Message content is the
 * JSON-encoded UI message, stored inline.
 */
export const SESSION_HISTORY_INIT_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  instance_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  parent_instance_id TEXT,
  extension_identifier TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT,
  generation_error TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  trimmed_message_count INTEGER NOT NULL DEFAULT 0,
  byte_size INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  session_id TEXT NOT NULL,
  ord INTEGER NOT NULL,
  instance_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  persisted_at TEXT NOT NULL,
  is_checkpoint INTEGER NOT NULL DEFAULT 0,
  covers_through_ord INTEGER,
  PRIMARY KEY (session_id, ord)
);

CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions (created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_kind_created_at ON sessions (kind, created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions (parent_instance_id);
CREATE INDEX IF NOT EXISTS idx_sessions_ended ON sessions (ended_at, updated_at);
CREATE INDEX IF NOT EXISTS idx_messages_instance_ord ON messages (instance_id, ord);
CREATE INDEX IF NOT EXISTS idx_messages_session_checkpoint ON messages (session_id, is_checkpoint, ord);
`;

/**
 * v1 → v2: rebuild `messages` as a per-`session_id` log.
 *
 * `ord` follows instance creation order, then the old per-instance `seq`.
 * Legacy compaction summaries become checkpoints covering their predecessor
 * in the same instance (the anchor they were inserted after). Rows without a
 * session row keep their instance id as the logical session id.
 */
export const SESSION_HISTORY_MIGRATIONS =
  LOCAL_DATA_MIGRATIONS.sessions.migrations;

export const SESSION_HISTORY_STORE_DEFINITION: SqliteStoreDefinition = {
  kind: 'sqlite',
  id: 'sessions',
  relativePath: SESSION_HISTORY_RELATIVE_PATH,
  required: false,
  createIfMissing: true,
  schemaVersion: SESSION_HISTORY_SCHEMA_VERSION,
  // Older binaries reject schema v3; no separate floor is needed.
  compatibilityVersion: 1,
  // First release shipping durable generation health (feat → minor after 0.25.x).
  minimumKlexVersion: '0.26.0',
  // Must run before the first table exists; afterwards it has no effect.
  initPragmas: ['PRAGMA auto_vacuum = INCREMENTAL'],
  initSql: SESSION_HISTORY_INIT_SQL,
  migrations: SESSION_HISTORY_MIGRATIONS,
  validate: async (client) => {
    await client.execute(
      'SELECT instance_id, generation_error FROM sessions LIMIT 1',
    );
    await client.execute(
      `SELECT session_id, ord, instance_id, message_id, is_checkpoint,
              covers_through_ord
       FROM messages LIMIT 1`,
    );
    const result = await client.execute('PRAGMA auto_vacuum');
    const mode = Number(result.rows[0]?.auto_vacuum);
    if (mode !== 2) {
      throw new Error(
        `Session history store must use incremental auto_vacuum (found ${mode})`,
      );
    }
  },
};
