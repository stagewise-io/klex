import type { JsonMigration } from '@/local-data';

import { skillRegistryV1Schema, skillRegistryV2Schema } from './schemas';

export const skillRegistryV1ToV2: JsonMigration = {
  from: 1,
  to: 2,
  name: 'rename-event-data-matcher',
  up(value) {
    const next = structuredClone(skillRegistryV1Schema.parse(value));
    for (const usage of Object.values(next.skills)) {
      if (!Array.isArray(usage.metadata.loadOn)) continue;
      usage.metadata.loadOn = usage.metadata.loadOn.map((matcher: unknown) =>
        matcher &&
        typeof matcher === 'object' &&
        'type' in matcher &&
        matcher.type === 'pushNotificationMetadataPattern'
          ? { ...matcher, type: 'eventDataPattern' }
          : matcher,
      );
    }
    return skillRegistryV2Schema.parse(next);
  },
};
