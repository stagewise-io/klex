import type { SqliteMigration } from '@/local-data';

export const sessionsV5ToV6: SqliteMigration = {
  from: 5,
  to: 6,
  name: 'persist-input-projections',
  up: async (client) => {
    for (const sql of [
      `CREATE TABLE input_projection_plans (revision TEXT PRIMARY KEY, family TEXT NOT NULL, shape TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL)`,
      `CREATE TABLE input_projection_feedback (revision TEXT NOT NULL, count INTEGER NOT NULL, reasons TEXT NOT NULL, PRIMARY KEY(revision))`,
      `CREATE TABLE input_projection_reviews (revision TEXT NOT NULL, batch INTEGER NOT NULL, reasons TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0, retry_after TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(revision, batch))`,
      `CREATE TABLE input_projection_bindings (reference TEXT PRIMARY KEY CHECK(length(reference) = 8), session_id TEXT NOT NULL, ord INTEGER NOT NULL, part INTEGER NOT NULL, context_hash TEXT NOT NULL, revision TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(session_id, ord, part))`,
      `CREATE INDEX idx_input_projection_family ON input_projection_plans(family, shape, created_at)`,
      `CREATE INDEX idx_input_projection_revision ON input_projection_bindings(revision)`,
      `CREATE INDEX idx_messages_projection_source ON messages(session_id, message_id)`,
      `CREATE TRIGGER input_projection_delete AFTER DELETE ON messages BEGIN DELETE FROM input_projection_bindings WHERE session_id = OLD.session_id AND ord = OLD.ord; END`,
      `CREATE TRIGGER input_projection_update AFTER UPDATE OF content, ord ON messages BEGIN
        DELETE FROM input_projection_bindings WHERE session_id = OLD.session_id AND ord = OLD.ord
          AND json_extract(OLD.content, '$.parts[' || part || '].data') IS NOT json_extract(NEW.content, '$.parts[' || part || '].data');
        UPDATE input_projection_bindings SET ord = NEW.ord WHERE session_id = OLD.session_id AND ord = OLD.ord;
      END`,
    ])
      await client.execute(sql);
  },
};
