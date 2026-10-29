import type { JsonMigration } from '@/local-data';

import { parseStoredKlexConfigV2 } from './config-contracts';

// Telemetry is no longer interpreted. The next step removes it.
export const configV2V3: JsonMigration = {
  from: 2,
  to: 3,
  name: 'rename-telemetry-levels',
  up: (value) => parseStoredKlexConfigV2(value),
};
