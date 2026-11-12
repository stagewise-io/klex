import { configV1ToV2 } from './config/v1-to-v2/migration';
import { configV1, configV2 } from './config/v1-to-v2/schemas';
import { configV2ToV3 } from './config/v2-to-v3/migration';
import { configV3 } from './config/v2-to-v3/schemas';
import { configV3ToV4 } from './config/v3-to-v4/migration';
import { configV4 } from './config/v3-to-v4/schemas';
import { configV4ToV5 } from './config/v4-to-v5/migration';
import { configV5 } from './config/v4-to-v5/schemas';
import { configV5ToV6 } from './config/v5-to-v6/migration';
import { configV6 } from './config/v5-to-v6/schemas';
import { configV6ToV7 } from './config/v6-to-v7/migration';
import { configV7 } from './config/v6-to-v7/schemas';
import { configV7ToV8 } from './config/v7-to-v8/migration';
import { configV8 } from './config/v7-to-v8/schemas';
import { configV8ToV9 } from './config/v8-to-v9/migration';
import { configV9 } from './config/v8-to-v9/schemas';
import { configV9ToV10 } from './config/v9-to-v10/migration';
import { configV10 } from './config/v9-to-v10/schemas';
import { episodicSearchV1ToV2 } from './episodic-search-index/v1-to-v2/migration';
import { learningStateV1ToV2 } from './learning-extension-state/v1-to-v2/migration';
import {
  learningStateV1,
  learningStateV2,
} from './learning-extension-state/v1-to-v2/schemas';
import { modelCallsV1ToV2 } from './model-calls/v1-to-v2/migration';
import { modelCallsV2ToV3 } from './model-calls/v2-to-v3/migration';
import { sessionsV1ToV2 } from './sessions/v1-to-v2/migration';
import { sessionsV2ToV3 } from './sessions/v2-to-v3/migration';
import { sessionsV3ToV4 } from './sessions/v3-to-v4/migration';

// Data-only and append-only: CI compares import identities and array prefixes.
export const LOCAL_DATA_MIGRATIONS = {
  config: {
    versions: [
      configV1,
      configV2,
      configV3,
      configV4,
      configV5,
      configV6,
      configV7,
      configV8,
      configV9,
      configV10,
    ],
    migrations: [
      configV1ToV2,
      configV2ToV3,
      configV3ToV4,
      configV4ToV5,
      configV5ToV6,
      configV6ToV7,
      configV7ToV8,
      configV8ToV9,
      configV9ToV10,
    ],
  },
  'learning-extension-state': {
    versions: [learningStateV1, learningStateV2],
    migrations: [learningStateV1ToV2],
  },
  'model-calls': { migrations: [modelCallsV1ToV2, modelCallsV2ToV3] },
  sessions: { migrations: [sessionsV1ToV2, sessionsV2ToV3, sessionsV3ToV4] },
  'episodic-search-index': { migrations: [episodicSearchV1ToV2] },
};
