-- Frozen persisted episode-summary schema 1 (Klex 0.28.1 through 0.29.x), before sources.
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO meta VALUES
  ('store', 'episode-summaries'), ('schemaVersion', '1'),
  ('compatibilityVersion', '2'), ('minimumKlexVersion', '0.28.1'),
  ('writtenByKlexVersion', '0.29.0');
CREATE TABLE summaries (
  episode_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('titled', 'skipped')),
  title TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  model_id TEXT
);
CREATE INDEX summaries_listing
  ON summaries (status, started_at DESC, episode_id DESC);
CREATE TABLE summary_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO summaries VALUES
  ('episode-titled', 'titled', 'Fixed the flaky login test',
   '2026-10-01T10:00:00.000Z', '2026-10-01T10:05:00.000Z',
   '2026-10-01T10:06:00.000Z', 'test:model'),
  ('episode-skipped', 'skipped', NULL,
   '2026-10-01T11:00:00.000Z', '2026-10-01T11:00:10.000Z',
   '2026-10-01T11:01:00.000Z', NULL);
INSERT INTO summary_state VALUES
  ('cursor', 'episode-skipped'), ('cursor_initialized', 'true');
