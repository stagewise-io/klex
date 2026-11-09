import type { JsonMigration } from '@/local-data';

import { configV2Schema } from './v2';

// Released behavior: telemetry is no longer interpreted; 3→4 removes it.
export const configV2ToV3: JsonMigration = {
  from: 2,
  to: 3,
  name: 'rename-telemetry-levels',
  up: (value) => configV2Schema.parse(value),
};
