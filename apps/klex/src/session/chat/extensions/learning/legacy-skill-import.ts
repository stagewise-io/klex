import { lstat, readdir, readFile, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { ModuleLogger } from '@stagewise/logger';

import {
  parseSkill,
  type SkillDocument,
  type SkillNamespaceHandle,
  type SkillSeed,
  validateSkill,
} from '@/skills';

import type { LearningState, SkillState } from './learning-state';

const SKILL_FILE = 'SKILL.md';

export interface LegacySkillImportOptions {
  /** `{extensionDataDir}/skills`, the pre-registry skill location. */
  legacyRoot: string;
  skills: SkillNamespaceHandle;
  state: LearningState;
  logger: ModuleLogger;
}

export interface LegacySkillImportResult {
  imported: number;
  /** Legacy folders left in place; retried on the next start. */
  remaining: number;
}

/**
 * Moves pre-registry learned skills into the learning namespace. Each skill
 * is written to the registry before its legacy folder is removed, so a crash
 * in between re-imports identical content on the next start, which the
 * registry treats as a no-op; seeds apply while the skill has no persisted
 * bookkeeping. Unparseable folders stay in place and keep their bookkeeping.
 */
export async function importLegacySkills(
  options: LegacySkillImportOptions,
): Promise<LegacySkillImportResult> {
  const { legacyRoot, skills, state, logger } = options;
  const entries = await readdir(legacyRoot, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    },
  );
  if (entries === null) {
    // A crash after removing the legacy root can leave stale bookkeeping.
    if (Object.keys(state.get().skills).length > 0) {
      await state.update((draft) => {
        draft.skills = {};
      });
    }
    return { imported: 0, remaining: 0 };
  }

  const usage = state.get().skills;
  const remaining = new Set<string>();
  let imported = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      remaining.add(entry.name);
      continue;
    }
    const directory = join(legacyRoot, entry.name);
    const document = await readLegacySkill(directory, entry.name);
    if (!document) {
      logger.warn(
        { skill: entry.name },
        'Keeping legacy skill folder that cannot be imported',
      );
      remaining.add(entry.name);
      continue;
    }
    const previous = Object.hasOwn(usage, entry.name)
      ? usage[entry.name]
      : undefined;
    try {
      await skills.put(
        document.name,
        { description: document.description, body: document.body },
        {
          // The legacy folder holds the only copy of its usage until the
          // registry bookkeeping is on disk.
          durable: true,
          ...(previous
            ? {
                seed: seedFrom(previous),
                metadata: { sourceEpisodes: sourcesFrom(previous) },
              }
            : {}),
        },
      );
      await rm(directory, { recursive: true, force: true });
      imported += 1;
    } catch (error) {
      logger.warn(
        { skill: entry.name, error },
        'Importing legacy skill failed; retrying on next start',
      );
      remaining.add(entry.name);
    }
  }

  if (remaining.size === 0) {
    await rmdir(legacyRoot).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error;
    });
  }
  // Bookkeeping of imported skills now lives in the registry.
  if (Object.keys(usage).some((name) => !remaining.has(name))) {
    await state.update((draft) => {
      draft.skills = Object.fromEntries(
        Object.entries(draft.skills).filter(([name]) => remaining.has(name)),
      );
    });
  }
  if (imported > 0 || remaining.size > 0) {
    logger.info(
      { imported, remaining: remaining.size },
      'Imported legacy learned skills',
    );
  }
  return { imported, remaining: remaining.size };
}

/** Null unless `{directory}/SKILL.md` is a regular file with a valid skill named like its folder. */
async function readLegacySkill(
  directory: string,
  name: string,
): Promise<SkillDocument | null> {
  const path = join(directory, SKILL_FILE);
  try {
    if (!(await lstat(path)).isFile()) return null;
    const document = parseSkill(await readFile(path, 'utf-8'));
    if (!document || document.name !== name || validateSkill(document))
      return null;
    return document;
  } catch {
    return null;
  }
}

function seedFrom(usage: SkillState): SkillSeed {
  return {
    createdAt: usage.createdAt,
    updatedAt: usage.updatedAt,
    lastReadAt: usage.lastReadAt,
    readCount: usage.readCount,
    userEdited: usage.userEdited === true,
  };
}

function sourcesFrom(usage: SkillState): string[] {
  return Array.isArray(usage.sourceEpisodes)
    ? usage.sourceEpisodes.filter((id): id is string => typeof id === 'string')
    : [];
}
