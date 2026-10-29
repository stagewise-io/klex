import type { SqliteMigration } from '@/local-data';

export const modelCallsV1V2: SqliteMigration = {
  from: 1,
  to: 2,
  name: 'add-provider-type',
  up: async (database) => {
    await database.execute(
      'ALTER TABLE model_calls ADD COLUMN provider_type TEXT',
    );
    await database.execute('DROP INDEX IF EXISTS idx_model_calls_split');
    await database.execute(
      'CREATE INDEX idx_model_calls_split ON model_calls (provider_type, provider_id, endpoint_id, model_id)',
    );
  },
};
