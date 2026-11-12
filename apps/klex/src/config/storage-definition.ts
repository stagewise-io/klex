import type { JsonStoreDefinition } from '@/local-data';
import { LOCAL_DATA_MIGRATIONS } from '@/local-data-migrations';

export const CONFIG_STORE_DEFINITION: JsonStoreDefinition = {
  kind: 'json',
  id: 'config',
  relativePath: 'config.json',
  required: true,
  schemaVersion: 10,
  // Schema 7 blocks older writers that still persist TTS/STT selections.
  // Schema 8 adds Codex `authMode`; the schema bump itself blocks older readers.
  // Schema 9 adds provider `displayName`, likewise blocked by the schema bump.
  // Schema 10 adds optional effort policy and blocks older strict readers.
  compatibilityVersion: 8,
  minimumKlexVersion: '0.31.1',
  legacySchemaVersion: 1,
  versions: LOCAL_DATA_MIGRATIONS.config.versions,
  migrations: LOCAL_DATA_MIGRATIONS.config.migrations,
};
