import type { JsonMigration } from '@/local-data';

import { configV6Schema } from './v6';
import { configV7OutputSchema } from './v7';

export function migrateConfigV6ToV7(input: unknown) {
  const config = configV6Schema.parse(input);
  return configV7OutputSchema.parse({
    ...config,
    modelSelection: {
      ...config.modelSelection,
      voice: { sts: config.modelSelection.voice.sts },
    },
  });
}
export const configV6ToV7: JsonMigration = {
  from: 6,
  to: 7,
  name: 'drop-legacy-voice-selections',
  up: (value) => migrateConfigV6ToV7(value),
};
