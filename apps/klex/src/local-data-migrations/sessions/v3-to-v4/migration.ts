import type { SqliteMigration } from '@/local-data';

/** Stable revisions without reading transcript bodies during activity manifests. */
export const sessionsV3ToV4: SqliteMigration = {
  from: 3,
  to: 4,
  name: 'session-content-revisions',
  up: async (client) => {
    await client.execute(
      'ALTER TABLE messages ADD COLUMN content_revision TEXT',
    );
  },
};
