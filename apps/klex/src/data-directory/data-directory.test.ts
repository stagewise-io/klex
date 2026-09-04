import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ensureDataDirectory } from './data-directory';

const directories: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'klex-data-dir-test-'));
  directories.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('ensureDataDirectory', () => {
  it('creates the directory including missing parents', async () => {
    const root = await makeTempDir();
    // Mirrors the default layout: $KLEX_HOME/agents/default, where neither
    // level exists on a fresh machine.
    const dataDirectory = join(root, 'home', 'agents', 'default');

    await ensureDataDirectory(dataDirectory);

    expect((await stat(dataDirectory)).isDirectory()).toBe(true);
  });

  it('leaves an existing directory and its contents untouched', async () => {
    const dataDirectory = await makeTempDir();
    const existing = join(dataDirectory, 'config.json');
    await writeFile(existing, '{}', 'utf8');

    await ensureDataDirectory(dataDirectory);
    await ensureDataDirectory(dataDirectory);

    expect((await stat(existing)).isFile()).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'restricts a newly created directory to the owner',
    async () => {
      const dataDirectory = join(await makeTempDir(), 'agents', 'default');

      await ensureDataDirectory(dataDirectory);

      expect((await stat(dataDirectory)).mode & 0o777).toBe(0o700);
    },
  );

  it('reports the offending path when the directory cannot be created', async () => {
    const root = await makeTempDir();
    const blocker = join(root, 'agents');
    await writeFile(blocker, 'not a directory', 'utf8');
    const dataDirectory = join(blocker, 'default');

    await expect(ensureDataDirectory(dataDirectory)).rejects.toThrow(
      dataDirectory,
    );
  });
});
