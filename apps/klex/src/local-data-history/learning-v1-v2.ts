import type { JsonMigration } from '@/local-data';

import { learningV1 } from './learning-contracts';

export const learningV1V2: JsonMigration = {
  from: 1,
  to: 2,
  name: 'episode-activity',
  up: (value) => {
    const old = learningV1.parse(value);
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
