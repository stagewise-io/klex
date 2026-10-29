-- Frozen per-instance message schema, before logical session ord/checkpoints.
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO meta VALUES
  ('store', 'sessions'), ('schemaVersion', '1'),
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
  instance_id TEXT NOT NULL, seq INTEGER NOT NULL, message_id TEXT NOT NULL,
  role TEXT NOT NULL, content TEXT NOT NULL, byte_size INTEGER NOT NULL,
  persisted_at TEXT NOT NULL, PRIMARY KEY (instance_id, seq)
);
CREATE INDEX idx_sessions_created_at ON sessions (created_at);
CREATE INDEX idx_sessions_kind_created_at ON sessions (kind, created_at);
CREATE INDEX idx_sessions_parent ON sessions (parent_instance_id);
CREATE INDEX idx_sessions_ended ON sessions (ended_at, updated_at);
CREATE INDEX idx_messages_instance_seq ON messages (instance_id, seq);
INSERT INTO sessions VALUES (
  'instance-frozen', 'default', 'default', 'Frozen session', NULL, NULL,
  '2026-08-14T10:00:00.000Z', '2026-08-14T10:00:02.000Z', NULL, NULL, 2, 0, 140
);
INSERT INTO messages VALUES
  ('instance-frozen', 0, 'user-frozen', 'user',
   '{"id":"user-frozen","role":"user","parts":[{"type":"text","text":"hello"}]}',
   78, '2026-08-14T10:00:00.000Z'),
  ('instance-frozen', 1, 'summary-frozen', 'assistant',
   '{"id":"summary-frozen","role":"assistant","parts":[{"type":"data-context-summary","data":{"summary":"remember hello"}}]}',
   130, '2026-08-14T10:00:02.000Z');
