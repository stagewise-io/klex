import type { JsonMigration } from '@/local-data';

import { learningStateV1Schema } from './schemas';

export const learningStateV1ToV2: JsonMigration = {
  from: 1,
  to: 2,
  name: 'episode-activity',
  up: (value) => {
    const old = learningStateV1Schema.parse(value);
    return {
      ...old,
      processedEpisodeCount: 0,
      pendingChangeWeight: 0,
      lastConsolidationEpisode: 0,
      lastConsolidationSkillCount: 0,
      consolidationFailures: 0,
      nextConsolidationEpisode: null,
      deferred: [],
      skills: Object.fromEntries(
        Object.entries(old.skills).map(([name, skill]) => [
          name,
          {
            ...skill,
            createdEpisode: 0,
            updatedEpisode: 0,
            lastReadEpisode: null,
          },
        ]),
      ),
    };
  },
};
