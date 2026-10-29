-- Frozen logical-session message schema, before generation health.
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO meta VALUES
  ('store', 'sessions'), ('schemaVersion', '2'),
  ('compatibilityVersion', '1'), ('minimumKlexVersion', '0.1.0'),
  ('writtenByKlexVersion', '0.1.0');
CREATE TABLE sessions (
  instance_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, kind TEXT NOT NULL,
  name TEXT NOT NULL, parent_instance_id TEXT, extension_identifier TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, ended_at TEXT,
  end_reason TEXT, message_count INTEGER NOT NULL DEFAULT 0,
  trimmed_message_count INTEGER NOT NULL DEFAULT 0, byte_size INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE messages (
  session_id TEXT NOT NULL, ord INTEGER NOT NULL, instance_id TEXT NOT NULL,
  message_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
  byte_size INTEGER NOT NULL, persisted_at TEXT NOT NULL,
  is_checkpoint INTEGER NOT NULL DEFAULT 0, covers_through_ord INTEGER,
  PRIMARY KEY (session_id, ord)
);
CREATE INDEX idx_sessions_created_at ON sessions (created_at);
CREATE INDEX idx_sessions_kind_created_at ON sessions (kind, created_at);
CREATE INDEX idx_sessions_parent ON sessions (parent_instance_id);
CREATE INDEX idx_sessions_ended ON sessions (ended_at, updated_at);
CREATE INDEX idx_messages_instance_ord ON messages (instance_id, ord);
CREATE INDEX idx_messages_session_checkpoint ON messages (session_id, is_checkpoint, ord);
INSERT INTO sessions VALUES (
  'instance-frozen', 'default', 'default', 'Frozen session', NULL, NULL,
  '2026-08-14T10:00:00.000Z', '2026-08-14T10:00:02.000Z', NULL, NULL, 2, 0, 140
);
INSERT INTO messages VALUES
  ('default', 0, 'instance-frozen', 'user-frozen', 'user',
   '{"id":"user-frozen","role":"user","parts":[{"type":"text","text":"hello"}]}',
   78, '2026-08-14T10:00:00.000Z', 0, NULL),
  ('default', 1, 'instance-frozen', 'summary-frozen', 'user',
   '{"id":"summary-frozen","role":"user","parts":[{"type":"data-context-summary","data":{"summary":"remember hello"}}]}',
   125, '2026-08-14T10:00:02.000Z', 1, 0);
