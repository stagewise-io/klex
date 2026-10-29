import type { JsonMigration } from '@/local-data';

import { configV4Schema } from './v4';
import { configV5OutputSchema } from './v5';

export function migrateConfigV4ToV5(input: unknown) {
  const {
    episodeFinishIdleTriggerTimeMs,
    memoryWriteIntervalMs: _memoryWriteIntervalMs,
    memoryWriteStepInterval: _memoryWriteStepInterval,
    ...rest
  } = configV4Schema.parse(input);
  return configV5OutputSchema.parse({
    ...rest,
    extensions: {
      memory: { episodes: { idleTimeoutMs: episodeFinishIdleTriggerTimeMs } },
    },
  });
}
export const configV4ToV5: JsonMigration = {
  from: 4,
  to: 5,
  name: 'nest-memory-extension-config',
  up: (value) => migrateConfigV4ToV5(value),
};
