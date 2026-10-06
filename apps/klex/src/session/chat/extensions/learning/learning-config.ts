/**
 * Starting values for the learning extension. Tune here; they are code
 * constants on purpose so changes need no config migration.
 */

/** First run after start, so learning does not compete with startup. */
export const STARTUP_DELAY_MS = 120_000;
export const RUN_INTERVAL_MS = 600_000;
export const MAX_EPISODES_PER_RUN = 3;
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

export const CONSOLIDATE_AFTER_CHANGED_RUNS = 10;
export const CONSOLIDATE_MAX_INTERVAL_MS = 86_400_000;
/** Skills unread for this long are flagged stale for consolidation. */
export const STALE_AFTER_MS = 2_592_000_000;

export const EXTRACTION_MAX_OUTPUT_TOKENS = 4_000;
export const CONSOLIDATION_MAX_OUTPUT_TOKENS = 8_000;

export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
