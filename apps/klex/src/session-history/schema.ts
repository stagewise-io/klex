import type { SqliteStoreDefinition } from '@/local-data';
import { LOCAL_DATA_MIGRATIONS } from '@/local-data-migrations';

/** Schema version — increment when adding migrations. */
export const SESSION_HISTORY_SCHEMA_VERSION = 6;

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
  content_revision TEXT,
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
CREATE TABLE input_projection_plans (revision TEXT PRIMARY KEY, family TEXT NOT NULL, shape TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE input_projection_feedback (revision TEXT NOT NULL, section TEXT NOT NULL, count INTEGER NOT NULL, reasons TEXT NOT NULL, PRIMARY KEY(revision, section));
CREATE TABLE input_projection_reviews (revision TEXT NOT NULL, section TEXT NOT NULL, batch INTEGER NOT NULL, reasons TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0, retry_after TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(revision, section, batch));
CREATE TABLE input_projection_bindings (reference TEXT PRIMARY KEY CHECK(length(reference) = 8), session_id TEXT NOT NULL, ord INTEGER NOT NULL, part INTEGER NOT NULL, context_hash TEXT NOT NULL, revision TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(session_id, ord, part));
CREATE INDEX idx_input_projection_family ON input_projection_plans(family, shape, created_at);
CREATE INDEX idx_input_projection_revision ON input_projection_bindings(revision);
CREATE INDEX idx_messages_projection_source ON messages(session_id, message_id);
CREATE TRIGGER input_projection_delete AFTER DELETE ON messages BEGIN DELETE FROM input_projection_bindings WHERE session_id = OLD.session_id AND ord = OLD.ord; END;
CREATE TRIGGER input_projection_update AFTER UPDATE OF content, ord ON messages BEGIN
  DELETE FROM input_projection_bindings WHERE session_id = OLD.session_id AND ord = OLD.ord
    AND json_extract(OLD.content, '$.parts[' || part || '].data') IS NOT json_extract(NEW.content, '$.parts[' || part || '].data');
  UPDATE input_projection_bindings SET ord = NEW.ord WHERE session_id = OLD.session_id AND ord = OLD.ord;
END;
CREATE TABLE memory_snapshots (hash TEXT PRIMARY KEY, content TEXT NOT NULL);
CREATE TABLE message_memory_snapshots (
  session_id TEXT NOT NULL, ord INTEGER NOT NULL, hash TEXT NOT NULL,
  PRIMARY KEY (session_id, ord, hash)
);
CREATE INDEX idx_message_memory_snapshot_hash ON message_memory_snapshots(hash);
CREATE TRIGGER messages_memory_insert AFTER INSERT ON messages BEGIN
  INSERT OR IGNORE INTO message_memory_snapshots
  SELECT NEW.session_id, NEW.ord, json_extract(value.value, '$.snapshotRef')
  FROM json_each(NEW.content, '$.parts') AS part, json_each(part.value, '$.data') AS value
  WHERE json_extract(part.value, '$.type') IN ('data-loadedMemories', 'data-loadedMemorySections')
    AND value.type = 'object' AND json_type(value.value, '$.snapshotRef') = 'text';
END;
CREATE TRIGGER messages_memory_update AFTER UPDATE OF content, ord, session_id ON messages BEGIN
  DELETE FROM message_memory_snapshots WHERE session_id = OLD.session_id AND ord = OLD.ord;
  INSERT OR IGNORE INTO message_memory_snapshots
  SELECT NEW.session_id, NEW.ord, json_extract(value.value, '$.snapshotRef')
  FROM json_each(NEW.content, '$.parts') AS part, json_each(part.value, '$.data') AS value
  WHERE json_extract(part.value, '$.type') IN ('data-loadedMemories', 'data-loadedMemorySections')
    AND value.type = 'object' AND json_type(value.value, '$.snapshotRef') = 'text';
END;
CREATE TRIGGER messages_memory_delete AFTER DELETE ON messages BEGIN
  DELETE FROM message_memory_snapshots WHERE session_id = OLD.session_id AND ord = OLD.ord;
END;
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
  // Older binaries must not read storage-only snapshot references.
  compatibilityVersion: 1,
  // Next stable release after the released schema-5 binary.
  minimumKlexVersion: '0.38.3',
  // Must run before the first table exists; afterwards it has no effect.
  initPragmas: ['PRAGMA auto_vacuum = INCREMENTAL'],
  initSql: SESSION_HISTORY_INIT_SQL,
  migrations: SESSION_HISTORY_MIGRATIONS,
  validate: async (client) => {
    await client.execute(
      'SELECT revision, section, count, reasons FROM input_projection_feedback LIMIT 1',
    );
    await client.execute(
      'SELECT revision, section, batch, reasons, completed, retry_after, attempts FROM input_projection_reviews LIMIT 1',
    );
    await client.execute(
      'SELECT revision, family, shape, body FROM input_projection_plans LIMIT 1',
    );
    await client.execute(
      'SELECT reference, session_id, ord, part, context_hash, revision FROM input_projection_bindings LIMIT 1',
    );
    await client.execute('SELECT hash, content FROM memory_snapshots LIMIT 1');
    await client.execute(
      'SELECT session_id, ord, hash FROM message_memory_snapshots LIMIT 1',
    );
    await client.execute(
      'SELECT instance_id, generation_error FROM sessions LIMIT 1',
    );
    await client.execute(
      `SELECT session_id, ord, instance_id, message_id, is_checkpoint,
              covers_through_ord, content_revision
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
