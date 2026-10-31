/**
 * Limits of the core skill registry. Code constants on purpose so changes
 * need no config migration.
 */

export const MAX_NAME_LENGTH = 64;
export const MAX_DESCRIPTION_LENGTH = 300;
export const MAX_BODY_LENGTH = 4_000;
/** Cap of the skill list in the main-session system prompt. */
export const MAX_PROMPT_LIST_CHARACTERS = 6_000;
/** Cap of the serialized namespace-owned metadata of one skill. */
export const MAX_METADATA_BYTES = 4_096;

/** Skill names and namespaces share the Agent Skills name syntax. */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Namespaces no extension may claim. `user` is kept for user-managed skills. */
export const RESERVED_SKILL_NAMESPACES: readonly string[] = ['user'];
