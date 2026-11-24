import type { SqliteMigration } from '@/local-data';

/** Inline legacy rows remain valid; new writes intern memory snapshot strings. */
export const sessionsV4ToV5: SqliteMigration = {
  from: 4,
  to: 5,
  name: 'intern-memory-snapshots',
  up: async (client) => {
    for (const sql of [
      `
CREATE TABLE memory_snapshots (
  hash TEXT PRIMARY KEY,
  content TEXT NOT NULL
);`,
      `
CREATE TABLE message_memory_snapshots (
  session_id TEXT NOT NULL,
  ord INTEGER NOT NULL,
  hash TEXT NOT NULL,
  PRIMARY KEY (session_id, ord, hash)
);`,
      `
CREATE INDEX idx_message_memory_snapshot_hash ON message_memory_snapshots(hash);`,
      `
CREATE TRIGGER messages_memory_insert AFTER INSERT ON messages BEGIN
  INSERT OR IGNORE INTO message_memory_snapshots
  SELECT NEW.session_id, NEW.ord, json_extract(value.value, '$.snapshotRef')
  FROM json_each(NEW.content, '$.parts') AS part,
       json_each(part.value, '$.data') AS value
  WHERE json_extract(part.value, '$.type') IN ('data-loadedMemories', 'data-loadedMemorySections')
    AND value.type = 'object'
    AND json_type(value.value, '$.snapshotRef') = 'text';
END;`,
      `
CREATE TRIGGER messages_memory_update AFTER UPDATE OF content, ord, session_id ON messages BEGIN
  DELETE FROM message_memory_snapshots WHERE session_id = OLD.session_id AND ord = OLD.ord;
  INSERT OR IGNORE INTO message_memory_snapshots
  SELECT NEW.session_id, NEW.ord, json_extract(value.value, '$.snapshotRef')
  FROM json_each(NEW.content, '$.parts') AS part,
       json_each(part.value, '$.data') AS value
  WHERE json_extract(part.value, '$.type') IN ('data-loadedMemories', 'data-loadedMemorySections')
    AND value.type = 'object'
    AND json_type(value.value, '$.snapshotRef') = 'text';
END;`,
      `
CREATE TRIGGER messages_memory_delete AFTER DELETE ON messages BEGIN
  DELETE FROM message_memory_snapshots WHERE session_id = OLD.session_id AND ord = OLD.ord;
END;`,
    ])
      await client.execute(sql);
  },
};
