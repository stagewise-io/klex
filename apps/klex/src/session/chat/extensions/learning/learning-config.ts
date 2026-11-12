export {
  MAX_BODY_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_NAME_LENGTH,
  SKILL_NAME_PATTERN,
} from '@/skills';

/** Skill namespace owned by the learning extension. */
export const LEARNING_SKILL_NAMESPACE = 'learning';

/**
 * Starting values for the learning extension. Tune here; they are code
 * constants on purpose so changes need no config migration.
 */

/** Consolidate the skill set after this many compaction-triggered runs. */
export const CONSOLIDATE_EVERY_RUNS = 3;
/** Largest chunk sent to one extraction; longer ranges are split into several. */
export const MAX_EPISODE_CHARACTERS = 60_000;
/** After this many consecutive failures an episode is skipped. */
export const MAX_FAILURES_PER_EPISODE = 3;

/** Cap of skills in the learning namespace. */
export const MAX_SKILLS = 30;
/** Provenance kept per skill; older episode ids are dropped. */
export const MAX_SOURCE_EPISODES = 20;

/** Agent turns without creation, change, or read after which a skill is stale. */
export const STALE_AFTER_TURNS = 300;
