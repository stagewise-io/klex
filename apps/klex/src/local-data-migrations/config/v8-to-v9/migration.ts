import type { JsonMigration } from '@/local-data';

import { configV8Schema } from './v8';
import { configV9Schema } from './v9';

// Schema 9 only adds an optional provider `displayName`. Every valid schema-8
// payload is a valid schema-9 payload, so the persisted value is returned
// unchanged after validating both contracts.
export function migrateConfigV8ToV9(
  input: Record<string, unknown>,
): Record<string, unknown> {
  configV8Schema.parse(input);
  configV9Schema.parse(input);
  return input;
}

export const configV8ToV9: JsonMigration = {
  from: 8,
  to: 9,
  name: 'add-provider-display-name',
  up: (value) => migrateConfigV8ToV9(value),
};
