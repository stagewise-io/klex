import { execFileSync } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
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

  it('preserves existing file permissions during atomic updates', async () => {
    const dir = await root();
    const store = createSkillStore(dir, logger);
    await store.write(skill);
    const path = join(dir, skill.name, 'SKILL.md');
    await chmod(path, 0o600);
    await store.write({ ...skill, body: 'updated' });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(dir, skill.name))).toEqual(['SKILL.md']);
  });

  it.skipIf(process.platform === 'win32')(
    'skips FIFOs on startup and refuses to replace them',
    async () => {
      const dir = await root();
      const path = join(dir, skill.name, 'SKILL.md');
      await mkdir(join(dir, skill.name), { recursive: true });
      execFileSync('mkfifo', [path]);
      const store = createSkillStore(dir, logger);
      await store.start();
      expect(store.list()).toEqual([]);
      await expect(store.write(skill)).rejects.toThrow(/not a regular file/);
      expect((await lstat(path)).isFIFO()).toBe(true);
      expect(await readdir(join(dir, skill.name))).toEqual(['SKILL.md']);
      expect(store.list()).toEqual([]);
    },
  );

  it('skips symlinked skill files but replaces the link without touching its target', async () => {
    const dir = await root();
    const outside = await root();
    await mkdir(outside, { recursive: true });
    const target = join(outside, 'SKILL.md');
    await writeFile(target, 'external');
    await mkdir(join(dir, skill.name), { recursive: true });
    const path = join(dir, skill.name, 'SKILL.md');
    await symlink(target, path);
    const store = createSkillStore(dir, logger);
    await store.start();
    expect(store.list()).toEqual([]);
    await store.write(skill);
    expect((await lstat(path)).isFile()).toBe(true);
    expect(await readFile(target, 'utf-8')).toBe('external');
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
