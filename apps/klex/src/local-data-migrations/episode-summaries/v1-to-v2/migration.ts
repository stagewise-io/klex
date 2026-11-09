import type { SqliteMigration } from '@/local-data';

/** Adds the JSON list of input origins; existing rows keep NULL (unknown). */
export const episodeSummariesV1ToV2: SqliteMigration = {
  from: 1,
  to: 2,
  name: 'add-summary-sources',
  up: async (database) => {
    await database.execute('ALTER TABLE summaries ADD COLUMN sources TEXT');
  },
};
