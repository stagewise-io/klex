import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ModuleLogger } from '@stagewise/logger';

import { createSkillStore } from './skill-store';

const directories: string[] = [];
const logger = {
  warn: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
} as unknown as ModuleLogger;

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function root(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'klex-skill-store-'));
  directories.push(directory);
  return join(directory, 'skills');
}

const skill = { name: 'retry-flaky-build', description: 'd', body: 'b' };

describe('skill store', () => {
  it('writes, updates, reads, and deletes skills', async () => {
    const dir = await root();
    const store = createSkillStore(dir, logger);
    await store.start();
    await store.write(skill);
    expect(store.get(skill.name)).toEqual(skill);
    expect(
      await readFile(join(dir, skill.name, 'SKILL.md'), 'utf-8'),
    ).toContain('description: "d"');
    await store.write({ ...skill, body: 'updated' });
    expect(store.read(skill.name)).toContain('updated');
    await store.delete(skill.name);
    expect(store.list()).toEqual([]);
    await expect(stat(join(dir, skill.name))).rejects.toThrow();
  });

  it('rejects invalid names and over-length content', async () => {
    const store = createSkillStore(await root(), logger);
    await expect(store.write({ ...skill, name: '..' })).rejects.toThrow();
    await expect(store.write({ ...skill, name: 'a/b' })).rejects.toThrow();
    await expect(
      store.write({ ...skill, body: 'x'.repeat(5_000) }),
    ).rejects.toThrow(/body too long/);
    await expect(store.delete('../outside')).rejects.toThrow();
  });

  it('skips and keeps corrupt folders, and reloads from disk', async () => {
    const dir = await root();
    const first = createSkillStore(dir, logger);
    await first.write(skill);
    await mkdir(join(dir, 'corrupt'));
    await writeFile(join(dir, 'corrupt', 'SKILL.md'), 'garbage');
    await mkdir(join(dir, 'empty'));

    const second = createSkillStore(dir, logger);
    await second.start();
    expect(second.list()).toEqual([skill]);
    expect(await readFile(join(dir, 'corrupt', 'SKILL.md'), 'utf-8')).toBe(
      'garbage',
    );
    expect(logger.warn).toHaveBeenCalled();
  });

  it('serializes concurrent writes to the same skill', async () => {
    const dir = await root();
    const store = createSkillStore(dir, logger);
    await Promise.all(
      ['one', 'two', 'three'].map((body) => store.write({ ...skill, body })),
    );
    expect(store.get(skill.name)?.body).toBe('three');
    const reloaded = createSkillStore(dir, logger);
    await reloaded.start();
    expect(reloaded.get(skill.name)?.body).toBe('three');
  });

  it('refuses to write through a symlinked skill folder', async () => {
    const dir = await root();
    const outside = await root();
    await mkdir(dir, { recursive: true });
    await symlink(outside, join(dir, skill.name));
    const store = createSkillStore(dir, logger);
    await expect(store.write(skill)).rejects.toThrow(/not a plain directory/);
    await expect(stat(join(outside, 'SKILL.md'))).rejects.toThrow();
  });
});
