import type { JsonMigration } from '@/local-data';

import { configV5Schema } from './v5';
import { configV6OutputSchema } from './v6';

export function migrateConfigV5ToV6(input: unknown) {
  return configV6OutputSchema.parse(configV5Schema.parse(input));
}
export const configV5ToV6: JsonMigration = {
  from: 5,
  to: 6,
  name: 'add-instinct-backends',
  up: (value) => migrateConfigV5ToV6(value),
};
