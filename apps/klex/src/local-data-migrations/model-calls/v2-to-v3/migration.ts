import type { SqliteMigration } from '@/local-data';

export const modelCallsV2ToV3: SqliteMigration = {
  from: 2,
  to: 3,
  name: 'add-api-and-usage-availability',
  up: async (database) => {
    await database.execute('ALTER TABLE model_calls ADD COLUMN api TEXT');
    await database.execute(
      'ALTER TABLE model_calls ADD COLUMN token_usage_reported INTEGER',
    );
    await database.execute(
      'ALTER TABLE model_calls ADD COLUMN cache_usage_reported INTEGER',
    );
  },
};
