import type { JsonMigration } from '@/local-data';

import { klexConfigSchema, storedKlexConfigV6Schema } from './config-contracts';

export function dropLegacyVoiceSelections(input: unknown) {
  const config = storedKlexConfigV6Schema.parse(input);
  return klexConfigSchema.parse({
    ...config,
    modelSelection: {
      ...config.modelSelection,
      voice: { sts: config.modelSelection.voice.sts },
    },
  });
}

export const configV6V7: JsonMigration = {
  from: 6,
  to: 7,
  name: 'drop-legacy-voice-selections',
  up: (value) => dropLegacyVoiceSelections(value),
};
