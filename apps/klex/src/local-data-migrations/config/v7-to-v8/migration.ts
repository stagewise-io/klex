import type { JsonMigration } from '@/local-data';

import { configV7Schema } from './v7';
import { configV8Schema } from './v8';

// Schema 8 only widens Codex provider settings with an optional `authMode`.
// Every valid schema-7 payload is a valid schema-8 payload, so the persisted
// value is returned unchanged after validating both contracts.
export function migrateConfigV7ToV8(
  input: Record<string, unknown>,
): Record<string, unknown> {
  configV7Schema.parse(input);
  configV8Schema.parse(input);
  return input;
}
export const configV7ToV8: JsonMigration = {
  from: 7,
  to: 8,
  name: 'add-codex-auth-mode',
  up: (value) => migrateConfigV7ToV8(value),
};
