import type { JsonMigration } from '@/local-data';

import { configV11Schema } from './v11';
import { configV12Schema } from './v12';

// Released schema-11 defaults. Values equal to them, or absent, are lifted;
// any other explicit value is a user choice and stays unchanged.
const LIFTED_DEFAULTS = [
  ['timeoutMs', 8_000, 12_000],
  ['classifierTimeoutMs', 4_000, 10_000],
] as const;

export const configV11ToV12: JsonMigration = {
  from: 11,
  to: 12,
  name: 'add-instinct-fallback-timers',
  up: (value) => {
    configV11Schema.parse(value);
    const next = structuredClone(value);
    // Absent instinct settings get the schema-12 defaults from the parser.
    if (
      typeof next.instinct !== 'object' ||
      next.instinct === null ||
      Array.isArray(next.instinct)
    )
      return next;
    const instinct = next.instinct as Record<string, unknown>;
    for (const [key, previous, lifted] of LIFTED_DEFAULTS) {
      if (instinct[key] === undefined || instinct[key] === previous)
        instinct[key] = lifted;
    }
    instinct.attemptTimeoutMs ??= 5_000;
    instinct.fallbackResetIdleMs ??= 600_000;
    configV12Schema.parse(next);
    return next;
  },
};
