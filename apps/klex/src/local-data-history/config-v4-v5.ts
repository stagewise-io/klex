import type { JsonMigration } from '@/local-data';

import {
  klexConfigV5Schema,
  storedKlexConfigV4Schema,
} from './config-contracts';

export function nestMemoryExtensionConfig(input: unknown) {
  const {
    episodeFinishIdleTriggerTimeMs,
    memoryWriteIntervalMs: _memoryWriteIntervalMs,
    memoryWriteStepInterval: _memoryWriteStepInterval,
    ...rest
  } = storedKlexConfigV4Schema.parse(input);
  return klexConfigV5Schema.parse({
    ...rest,
    extensions: {
      memory: { episodes: { idleTimeoutMs: episodeFinishIdleTriggerTimeMs } },
    },
  });
}

export const configV4V5: JsonMigration = {
  from: 4,
  to: 5,
  name: 'nest-memory-extension-config',
  up: (value) => nestMemoryExtensionConfig(value),
};
