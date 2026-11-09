import type { SqliteMigration } from '@/local-data';

export const sessionsV2ToV3: SqliteMigration = {
  from: 2,
  to: 3,
  name: 'session-generation-health',
  up: async (database) => {
    await database.execute(
      'ALTER TABLE sessions ADD COLUMN generation_error TEXT',
    );
  },
};
