import type { JsonStoreDefinition } from '@/local-data';
import { LOCAL_DATA_MIGRATIONS } from '@/local-data-migrations';

export const CONFIG_STORE_DEFINITION: JsonStoreDefinition = {
  kind: 'json',
  id: 'config',
  relativePath: 'config.json',
  required: true,
  schemaVersion: 14,
  // Schema 7 blocks older writers that still persist TTS/STT selections.
  // Schema 8 adds Codex `authMode`; the schema bump itself blocks older readers.
  // Schema 9 adds provider `displayName`, likewise blocked by the schema bump.
  // Schema 10 adds optional effort policy and blocks older strict readers.
  // Schema 11 adds MCP Events subscriptions after the released schema 10.
  // Schema 12 adds instinct fallback timers and lifts released defaults.
  compatibilityVersion: 8,
  // Schema 13 adds Langdock; older strict provider readers must not write it.
  // Schema 14 adds Klex Cloud, likewise blocked by the schema bump.
  minimumKlexVersion: '0.36.0',
  legacySchemaVersion: 1,
  versions: LOCAL_DATA_MIGRATIONS.config.versions,
  migrations: LOCAL_DATA_MIGRATIONS.config.migrations,
};
