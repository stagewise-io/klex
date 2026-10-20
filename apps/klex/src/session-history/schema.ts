import type { SqliteMigration, SqliteStoreDefinition } from '@/local-data';

/** Schema version — increment when adding migrations. */
export const SESSION_HISTORY_SCHEMA_VERSION = 2;

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
export const SESSION_HISTORY_MIGRATIONS: SqliteMigration[] = [
  {
    from: 1,
    to: 2,
    name: 'session-log-ord-and-checkpoints',
    up: async (database) => {
      await database.execute(`
        CREATE TABLE messages_v2 (
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
        )`);
      await database.execute(`
        INSERT INTO messages_v2 (
          session_id, ord, instance_id, message_id, role, content,
          byte_size, persisted_at
        )
        SELECT
          COALESCE(s.session_id, m.instance_id),
          ROW_NUMBER() OVER (
            PARTITION BY COALESCE(s.session_id, m.instance_id)
            ORDER BY s.created_at, m.instance_id, m.seq
          ) - 1,
          m.instance_id, m.message_id, m.role, m.content,
          m.byte_size, m.persisted_at
        FROM messages m
        LEFT JOIN sessions s ON s.instance_id = m.instance_id`);
      await database.execute({
        sql: `
          UPDATE messages_v2
          SET is_checkpoint = 1, covers_through_ord = ord - 1
          WHERE role = 'assistant'
            AND content LIKE ?
            AND EXISTS (
              SELECT 1 FROM messages_v2 p
              WHERE p.session_id = messages_v2.session_id
                AND p.ord = messages_v2.ord - 1
                AND p.instance_id = messages_v2.instance_id
            )`,
        args: [`%"type":"${CHECKPOINT_PART_TYPE}"%`],
      });
      // Legacy summaries were assistant messages. A restored window opens
      // with its header, and providers require a user-first conversation.
      await database.execute(`
        UPDATE messages_v2
        SET role = 'user',
            content = json_set(content, '$.role', 'user'),
            byte_size = length(CAST(json_set(content, '$.role', 'user') AS BLOB))
        WHERE is_checkpoint = 1 AND role <> 'user'`);
      await database.execute('DROP TABLE messages');
      await database.execute('ALTER TABLE messages_v2 RENAME TO messages');
      await database.execute(
        'CREATE INDEX idx_messages_instance_ord ON messages (instance_id, ord)',
      );
      await database.execute(
        'CREATE INDEX idx_messages_session_checkpoint ON messages (session_id, is_checkpoint, ord)',
      );
    },
  },
];

export const SESSION_HISTORY_STORE_DEFINITION: SqliteStoreDefinition = {
  kind: 'sqlite',
  id: 'sessions',
  relativePath: SESSION_HISTORY_RELATIVE_PATH,
  required: false,
  createIfMissing: true,
  schemaVersion: SESSION_HISTORY_SCHEMA_VERSION,
  // Older binaries already reject schema v2; no separate floor is needed.
  compatibilityVersion: 1,
  // First release shipping the session log (feat → minor after 0.22.x).
  minimumKlexVersion: '0.23.0',
  // Must run before the first table exists; afterwards it has no effect.
  initPragmas: ['PRAGMA auto_vacuum = INCREMENTAL'],
  initSql: SESSION_HISTORY_INIT_SQL,
  migrations: SESSION_HISTORY_MIGRATIONS,
  validate: async (client) => {
    await client.execute('SELECT instance_id FROM sessions LIMIT 1');
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
