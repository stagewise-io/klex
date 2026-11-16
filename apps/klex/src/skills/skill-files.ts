import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

import type { ModuleLogger } from '@stagewise/logger';

import {
  isValidSkillName,
  parseSkill,
  type SkillDocument,
  serializeSkill,
  validateReference,
  validateSkill,
} from './skill-format';
import { MAX_REFERENCES_PER_SKILL } from './skills-config';

const SKILL_FILE = 'SKILL.md';
const REFERENCES_DIRECTORY = 'references';

export interface SkillDocumentStore {
  /** Creates the root and loads all skills into the cache. Idempotent. */
  start(): Promise<void>;
  list(): readonly SkillDocument[];
  get(name: string): SkillDocument | null;
  /** Full `SKILL.md` content of a cached skill. */
  read(name: string): string | null;
  write(skill: SkillDocument): Promise<void>;
  /** Deletes the skill folder, references included. */
  delete(name: string): Promise<void>;
  /** Reference names (without `.md`) of a cached skill, sorted. */
  listReferences(name: string): readonly string[];
  readReference(name: string, reference: string): string | null;
  writeReference(
    name: string,
    reference: string,
    content: string,
  ): Promise<void>;
  /** False when the reference does not exist. */
  deleteReference(name: string, reference: string): Promise<boolean>;
}

/**
 * Skills as Agent Skills folders: `{root}/{name}/SKILL.md`. The
 * in-memory cache serves synchronous reads; it changes only after the disk
 * write succeeded. Unparseable folders are skipped, never deleted.
 */
class SkillDocumentStoreModule implements SkillDocumentStore {
  private readonly skills = new Map<string, SkillDocument>();
  private readonly references = new Map<string, Map<string, string>>();
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

  list(): readonly SkillDocument[] {
    return [...this.skills.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((skill) => ({ ...skill }));
  }

  get(name: string): SkillDocument | null {
    const skill = this.skills.get(name);
    return skill ? { ...skill } : null;
  }

  read(name: string): string | null {
    const skill = this.skills.get(name);
    return skill ? serializeSkill(skill) : null;
  }

  async write(skill: SkillDocument): Promise<void> {
    const normalized: SkillDocument = {
      name: skill.name,
      description: skill.description.trim(),
      body: skill.body.trim(),
    };
    const problem = validateSkill(normalized);
    if (problem) throw new Error(`Invalid skill: ${problem}`);
    const directory = this.skillDirectory(normalized.name);
    await this.serialize(async () => {
      await this.ensureRoot();
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
      await writeAtomic(
        join(directory, SKILL_FILE),
        serializeSkill(normalized),
      );
      this.skills.set(normalized.name, normalized);
    });
  }

  listReferences(name: string): readonly string[] {
    return [...(this.references.get(name)?.keys() ?? [])].sort();
  }

  readReference(name: string, reference: string): string | null {
    return this.references.get(name)?.get(reference) ?? null;
  }

  async writeReference(
    name: string,
    reference: string,
    content: string,
  ): Promise<void> {
    const normalized = content.trim();
    const problem = validateReference(reference, normalized);
    if (problem) throw new Error(`Invalid reference: ${problem}`);
    await this.serialize(async () => {
      if (!this.skills.has(name)) throw new Error(`Unknown skill "${name}"`);
      const existing = this.references.get(name) ?? new Map<string, string>();
      if (!existing.has(reference) && existing.size >= MAX_REFERENCES_PER_SKILL)
        throw new Error(
          `A skill holds at most ${MAX_REFERENCES_PER_SKILL} references`,
        );
      const directory = join(this.skillDirectory(name), REFERENCES_DIRECTORY);
      await mkdir(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
      if (!(await lstat(directory)).isDirectory())
        throw new Error(
          `References folder is not a plain directory: "${name}"`,
        );
      await writeAtomic(join(directory, `${reference}.md`), `${normalized}\n`);
      existing.set(reference, normalized);
      this.references.set(name, existing);
    });
  }

  async deleteReference(name: string, reference: string): Promise<boolean> {
    if (!isValidSkillName(reference)) return false;
    let deleted = false;
    await this.serialize(async () => {
      const existing = this.references.get(name);
      if (!existing?.has(reference)) return;
      await rm(
        join(
          this.skillDirectory(name),
          REFERENCES_DIRECTORY,
          `${reference}.md`,
        ),
        { force: true },
      );
      existing.delete(reference);
      deleted = true;
    });
    return deleted;
  }

  async delete(name: string): Promise<void> {
    if (!isValidSkillName(name))
      throw new Error(`Invalid skill name "${name}"`);
    const directory = this.skillDirectory(name);
    await this.serialize(async () => {
      await rm(directory, { recursive: true, force: true });
      this.skills.delete(name);
      this.references.delete(name);
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

  /** Creates the root; a symlinked root would redirect writes and deletes. */
  private async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    if (!(await lstat(this.root)).isDirectory()) {
      throw new Error(`Skill root is not a plain directory: "${this.root}"`);
    }
  }

  private async load(): Promise<void> {
    await this.ensureRoot();
    const entries = await readdir(this.root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(this.root, entry.name, SKILL_FILE);
      let content: string;
      try {
        content = await readRegularFile(path);
      } catch (error) {
        this.logger.warn(
          { skill: entry.name, error },
          'Skipping skill without readable SKILL.md',
        );
        continue;
      }
      const skill = parseSkill(content);
      if (!skill || skill.name !== entry.name || validateSkill(skill)) {
        this.logger.warn({ skill: entry.name }, 'Skipping malformed skill');
        continue;
      }
      this.skills.set(skill.name, skill);
      await this.loadReferences(skill.name);
    }
  }

  /** Invalid or oversized reference files are skipped, never deleted. */
  private async loadReferences(name: string): Promise<void> {
    const directory = join(this.root, name, REFERENCES_DIRECTORY);
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      () => [],
    );
    const loaded = new Map<string, string>();
    for (const entry of entries) {
      const reference = entry.name.replace(/\.md$/, '');
      if (!entry.isFile() || reference === entry.name) continue;
      try {
        const content = (
          await readRegularFile(join(directory, entry.name))
        ).trim();
        const problem = validateReference(reference, content);
        if (problem) throw new Error(problem);
        loaded.set(reference, content);
      } catch (error) {
        this.logger.warn(
          { skill: name, reference: entry.name, error },
          'Skipping unreadable skill reference',
        );
      }
    }
    if (loaded.size) this.references.set(name, loaded);
  }

  private serialize(action: () => Promise<void>): Promise<void> {
    const previous = this.work;
    const result = this.start().then(() => previous.then(action, action));
    this.work = result.catch(() => undefined);
    return result;
  }
}

/** Atomic replace that keeps the mode of an existing file and never follows a symlinked destination's target. */
async function writeAtomic(path: string, content: string): Promise<void> {
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (existing && !existing.isFile() && !existing.isSymbolicLink()) {
    throw new Error(`Skill destination is not a regular file: "${path}"`);
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, {
      encoding: 'utf-8',
      flag: 'wx',
      ...(existing?.isFile() ? { mode: existing.mode & 0o777 } : {}),
    });
    // chmod restores bits masked by the process umask.
    if (existing?.isFile()) await chmod(temporary, existing.mode & 0o777);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function readRegularFile(path: string): Promise<string> {
  const original = await lstat(path, { bigint: true });
  if (!original.isFile()) throw new Error('Not a regular file');
  const handle = await open(
    path,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) throw new Error('Not a regular file');
    // Windows lacks O_NOFOLLOW. Verify the opened file's identity before
    // reading so a link/file swapped after lstat is never trusted.
    if (opened.dev !== original.dev || opened.ino !== original.ino)
      throw new Error('File changed while opening');
    return await handle.readFile('utf-8');
  } finally {
    await handle.close();
  }
}

export function createSkillDocumentStore(
  root: string,
  logger: ModuleLogger,
): SkillDocumentStore {
  return new SkillDocumentStoreModule(root, logger);
}
