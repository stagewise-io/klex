import type { JsonMigration } from '@/local-data';

import { configV3Schema } from './v3';
import { configV4OutputSchema } from './v4';

export function migrateConfigV3ToV4(input: unknown) {
  return configV4OutputSchema.parse(configV3Schema.parse(input));
}
export const configV3ToV4: JsonMigration = {
  from: 3,
  to: 4,
  name: 'drop-telemetry-config',
  up: (value) => migrateConfigV3ToV4(value),
};
