import type { SqliteMigration } from '@/local-data';

/** Retire the disposable file-derived corpus; canonical history rebuilds it. */
export const episodicSearchV1ToV2: SqliteMigration = {
  from: 1,
  to: 2,
  name: 'canonical-activity-search',
  up: async (database) => {
    for (const statement of `
      DROP TABLE episodic_entries;
      DROP TABLE episodic_file_terms;
      DROP TABLE episodic_term_trigrams;
      DROP TABLE episodic_vocabulary;
      DROP TABLE episodic_files;
      CREATE TABLE activity_sources (
        source_id TEXT PRIMARY KEY, byte_size INTEGER NOT NULL, revision TEXT NOT NULL
      );
      CREATE TABLE activity_vocabulary (term TEXT PRIMARY KEY, frequency INTEGER NOT NULL);
      CREATE TABLE activity_term_trigrams (
        trigram TEXT NOT NULL, term TEXT NOT NULL REFERENCES activity_vocabulary(term) ON DELETE CASCADE,
        PRIMARY KEY (trigram, term)
      );
      CREATE INDEX activity_term_trigrams_lookup ON activity_term_trigrams (trigram);
      CREATE TABLE activity_source_terms (
        source_id TEXT NOT NULL, term TEXT NOT NULL, frequency INTEGER NOT NULL,
        PRIMARY KEY (source_id, term)
      );
      CREATE VIRTUAL TABLE activity_entries USING fts5(
        text, normalized_text UNINDEXED, source_id UNINDEXED,
        entry_ordinal UNINDEXED, occurred_at UNINDEXED, tokenize = 'porter unicode61'
      );
    `
      .split(';')
      .map((sql) => sql.trim())
      .filter(Boolean))
      await database.execute(statement);
  },
};
