import type { JsonStoreDefinition } from '@/local-data';
import { LOCAL_DATA_MIGRATIONS } from '@/local-data-migrations';

export const CONFIG_STORE_DEFINITION: JsonStoreDefinition = {
  kind: 'json',
  id: 'config',
  relativePath: 'config.json',
  required: true,
  schemaVersion: 7,
  // Schema 7 blocks older writers that still persist TTS/STT selections.
  compatibilityVersion: 8,
  minimumKlexVersion: '0.27.1',
  legacySchemaVersion: 1,
  versions: LOCAL_DATA_MIGRATIONS.config.versions,
  migrations: LOCAL_DATA_MIGRATIONS.config.migrations,
};
