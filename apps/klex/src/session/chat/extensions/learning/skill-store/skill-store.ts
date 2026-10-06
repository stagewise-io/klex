import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

import type { ModuleLogger } from '@stagewise/logger';

import {
  isValidSkillName,
  type LearnedSkill,
  parseSkill,
  serializeSkill,
  validateSkill,
} from './skill-format';

const SKILL_FILE = 'SKILL.md';

export interface SkillStore {
  /** Creates the root and loads all skills into the cache. Idempotent. */
  start(): Promise<void>;
  list(): readonly LearnedSkill[];
  get(name: string): LearnedSkill | null;
  /** Full `SKILL.md` content of a cached skill. */
  read(name: string): string | null;
  write(skill: LearnedSkill): Promise<void>;
  delete(name: string): Promise<void>;
}

/**
 * Learned skills as Agent Skills folders: `{root}/{name}/SKILL.md`. The
 * in-memory cache serves synchronous reads; it changes only after the disk
 * write succeeded. Unparseable folders are skipped, never deleted.
 */
class SkillStoreModule implements SkillStore {
  private readonly skills = new Map<string, LearnedSkill>();
  private startPromise: Promise<void> | undefined;
  private work: Promise<void> = Promise.resolve();

  constructor(
    private readonly root: string,
    private readonly logger: ModuleLogger,
  ) {}

  start(): Promise<void> {
    this.startPromise ??= this.load();
    return this.startPromise;
  }

  list(): readonly LearnedSkill[] {
    return [...this.skills.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((skill) => ({ ...skill }));
  }

  get(name: string): LearnedSkill | null {
    const skill = this.skills.get(name);
    return skill ? { ...skill } : null;
  }

  read(name: string): string | null {
    const skill = this.skills.get(name);
    return skill ? serializeSkill(skill) : null;
  }

  async write(skill: LearnedSkill): Promise<void> {
    const normalized: LearnedSkill = {
      name: skill.name,
      description: skill.description.trim(),
      body: skill.body.trim(),
    };
    const problem = validateSkill(normalized);
    if (problem) throw new Error(`Invalid skill: ${problem}`);
    const directory = this.skillDirectory(normalized.name);
    await this.serialize(async () => {
      await mkdir(this.root, { recursive: true });
      // Non-recursive, so an existing (even dangling) symlink is not followed.
      await mkdir(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
      // A symlinked skill folder would redirect the write outside the root.
      if (!(await lstat(directory)).isDirectory()) {
        throw new Error(
          `Skill folder is not a plain directory: "${normalized.name}"`,
        );
      }
      const path = join(directory, SKILL_FILE);
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, serializeSkill(normalized), {
        encoding: 'utf-8',
        flag: 'wx',
      });
      try {
        await rename(temporary, path);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
      this.skills.set(normalized.name, normalized);
    });
  }

  async delete(name: string): Promise<void> {
    if (!isValidSkillName(name))
      throw new Error(`Invalid skill name "${name}"`);
    const directory = this.skillDirectory(name);
    await this.serialize(async () => {
      await rm(directory, { recursive: true, force: true });
      this.skills.delete(name);
    });
  }

  private skillDirectory(name: string): string {
    const root = resolve(this.root);
    const directory = resolve(root, name);
    if (!directory.startsWith(`${root}${sep}`)) {
      throw new Error(`Skill path escapes the skill root: "${name}"`);
    }
    return directory;
  }

  private async load(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const entries = await readdir(this.root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(this.root, entry.name, SKILL_FILE);
      let content: string;
      try {
        content = await readFile(path, 'utf-8');
      } catch (error) {
        this.logger.warn(
          { skill: entry.name, error },
          'Skipping learned skill without readable SKILL.md',
        );
        continue;
      }
      const skill = parseSkill(content);
      if (!skill || skill.name !== entry.name || validateSkill(skill)) {
        this.logger.warn(
          { skill: entry.name },
          'Skipping malformed learned skill',
        );
        continue;
      }
      this.skills.set(skill.name, skill);
    }
  }

  private serialize(action: () => Promise<void>): Promise<void> {
    const previous = this.work;
    const result = this.start().then(() => previous.then(action, action));
    this.work = result.catch(() => undefined);
    return result;
  }
}

export function createSkillStore(
  root: string,
  logger: ModuleLogger,
): SkillStore {
  return new SkillStoreModule(root, logger);
}
