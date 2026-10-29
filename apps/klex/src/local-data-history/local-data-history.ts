import {
  configSchema1,
  configSchema2,
  configSchema3,
  configSchema4,
  configSchema5,
  configSchema6,
  configSchema7,
} from './config-storage-contracts';
import { configV1V2 } from './config-v1-v2';
import { configV2V3 } from './config-v2-v3';
import { configV3V4 } from './config-v3-v4';
import { configV4V5 } from './config-v4-v5';
import { configV5V6 } from './config-v5-v6';
import { configV6V7 } from './config-v6-v7';
import { learningSchema1, learningSchema2 } from './learning-storage-contracts';
import { learningV1V2 } from './learning-v1-v2';
import { modelCallsV1V2 } from './model-calls-v1-v2';
import { modelCallsV2V3 } from './model-calls-v2-v3';
import { sessionsV1V2 } from './sessions-v1-v2';
import { sessionsV2V3 } from './sessions-v2-v3';

// CI accepts only static imports and this literal, append-only registry.
export const LOCAL_DATA_HISTORY = {
  config: {
    versions: [
      configSchema1,
      configSchema2,
      configSchema3,
      configSchema4,
      configSchema5,
      configSchema6,
      configSchema7,
    ],
    migrations: [
      configV1V2,
      configV2V3,
      configV3V4,
      configV4V5,
      configV5V6,
      configV6V7,
    ],
  },
  'learning-extension-state': {
    versions: [learningSchema1, learningSchema2],
    migrations: [learningV1V2],
  },
  'model-calls': {
    migrations: [modelCallsV1V2, modelCallsV2V3],
  },
  sessions: {
    migrations: [sessionsV1V2, sessionsV2V3],
  },
};
