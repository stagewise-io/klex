/**
 * Starting values for the learning extension. Tune here; they are code
 * constants on purpose so changes need no config migration.
 */

export const PRIMARY_PASS_CHARACTERS = 120_000;
export const INVESTIGATION_MAX_STEPS = 6;
export const FAILURE_RETRY_DELAYS_MS = [30_000, 120_000] as const;
/** With no cursor yet, learn only from the newest N finished episodes. */
export const INITIAL_BACKFILL_EPISODES = 20;
/** Shorter episodes are skipped (the cursor still advances). */
export const MIN_EPISODE_CHARACTERS = 400;
/** Longer episode text is clipped; the tail is kept. */
export const MAX_EPISODE_CHARACTERS = 60_000;
/** After this many consecutive failures an episode is skipped. */
export const MAX_FAILURES_PER_EPISODE = 3;

export const MAX_SKILLS = 30;
export const MAX_NAME_LENGTH = 64;
export const MAX_DESCRIPTION_LENGTH = 300;
export const MAX_BODY_LENGTH = 4_000;
/** Provenance kept per skill; older episode ids are dropped. */
export const MAX_SOURCE_EPISODES = 20;
/** Cap of the skill list in the main-session system prompt. */
export const MAX_PROMPT_LIST_CHARACTERS = 6_000;

export const CONSOLIDATE_CHANGE_WEIGHT = 20;
export const SOFT_SKILL_COUNT = 25;
export const SOFT_THRESHOLD_CHANGE_WEIGHT = 5;
export const STALE_AFTER_EPISODES = 100;
export const STALE_CONSOLIDATION_SPACING = 10;

export const EXTRACTION_MAX_OUTPUT_TOKENS = 4_000;
export const CONSOLIDATION_MAX_OUTPUT_TOKENS = 8_000;

export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
