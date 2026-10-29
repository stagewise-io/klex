-- Frozen persisted model-call schema 1, before provider_type and usage availability.
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO meta VALUES
  ('store', 'model-calls'), ('schemaVersion', '1'),
  ('compatibilityVersion', '1'), ('minimumKlexVersion', '0.1.0'),
  ('writtenByKlexVersion', '0.1.0');
CREATE TABLE model_calls (
  id TEXT PRIMARY KEY, session_id TEXT, provider_id TEXT NOT NULL,
  endpoint_id TEXT, model_id TEXT NOT NULL, source TEXT NOT NULL,
  extension_id TEXT, input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  input_cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  input_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  ttft_ms REAL, total_duration_ms REAL, finish_reason TEXT NOT NULL,
  is_error INTEGER NOT NULL DEFAULT 0, error_type TEXT,
  started_at TEXT NOT NULL, finished_at TEXT NOT NULL
);
CREATE INDEX idx_model_calls_started_at ON model_calls (started_at);
CREATE INDEX idx_model_calls_split ON model_calls (provider_id, endpoint_id, model_id);
INSERT INTO model_calls VALUES (
  'call-frozen', 'default', 'primary', 'endpoint', 'gpt-4o', 'chat', NULL,
  123, 45, 6, 7, 8.5, 90, 'stop', 0, NULL,
  '2026-08-14T10:00:00.000Z', '2026-08-14T10:00:02.000Z'
);
