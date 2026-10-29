import type { SqliteMigration } from '@/local-data';

// Literal historical protocol value; never import the live session constant.
const CHECKPOINT_PART_TYPE = 'data-context-summary';

export const sessionsV1ToV2: SqliteMigration = {
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
};
