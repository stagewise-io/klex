import type { SqliteStoreDefinition } from '@/local-data';

/** Schema version — increment when adding migrations. */
export const SESSION_HISTORY_SCHEMA_VERSION = 1;

/** Relative path of the session-history database inside the data directory. */
export const SESSION_HISTORY_RELATIVE_PATH = 'sessions.sqlite';

/**
 * Multi-statement SQL for fresh database initialization.
 *
 * `sessions` holds one row per `ChatSession` instance. `messages` holds the
 * transcript of each instance, ordered by `seq`. Message content is the
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
  message_count INTEGER NOT NULL DEFAULT 0,
  trimmed_message_count INTEGER NOT NULL DEFAULT 0,
  byte_size INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  instance_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  persisted_at TEXT NOT NULL,
  PRIMARY KEY (instance_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions (created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_kind_created_at ON sessions (kind, created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions (parent_instance_id);
CREATE INDEX IF NOT EXISTS idx_sessions_ended ON sessions (ended_at, updated_at);
`;

export const SESSION_HISTORY_STORE_DEFINITION: SqliteStoreDefinition = {
  kind: 'sqlite',
  id: 'sessions',
  relativePath: SESSION_HISTORY_RELATIVE_PATH,
  required: false,
  createIfMissing: true,
  schemaVersion: SESSION_HISTORY_SCHEMA_VERSION,
  compatibilityVersion: 1,
  // First release shipping this store (feat → minor after 0.13.0).
  minimumKlexVersion: '0.14.0',
  // Must run before the first table exists; afterwards it has no effect.
  initPragmas: ['PRAGMA auto_vacuum = INCREMENTAL'],
  initSql: SESSION_HISTORY_INIT_SQL,
  migrations: [],
  validate: async (client) => {
    await client.execute('SELECT instance_id FROM sessions LIMIT 1');
    await client.execute('SELECT instance_id FROM messages LIMIT 1');
    const result = await client.execute('PRAGMA auto_vacuum');
    const mode = Number(result.rows[0]?.auto_vacuum);
    if (mode !== 2) {
      throw new Error(
        `Session history store must use incremental auto_vacuum (found ${mode})`,
      );
    }
  },
};
