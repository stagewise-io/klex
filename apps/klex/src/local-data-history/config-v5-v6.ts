import type { JsonMigration } from '@/local-data';

import {
  klexConfigV6Schema,
  storedKlexConfigV5Schema,
} from './config-contracts';

export function migrateInstinctConfig(input: unknown) {
  return klexConfigV6Schema.parse(storedKlexConfigV5Schema.parse(input));
}

export const configV5V6: JsonMigration = {
  from: 5,
  to: 6,
  name: 'add-instinct-backends',
  up: (value) => migrateInstinctConfig(value),
};
