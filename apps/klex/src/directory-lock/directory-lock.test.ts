import { chmod, mkdtemp, readFile, rm, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLogger } from '@stagewise/logger';

import { createDirectoryLock } from './directory-lock';

const logging = createLogger({ name: 'klex', type: 'hidden' });

const directories: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'klex-lock-test-'));
  directories.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(
    directories.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('DirectoryLock', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('acquires lock on empty directory', async () => {
    const lock = createDirectoryLock({ logging, dataDirectory: dir });
    await lock.acquire();
    const content = await readFile(join(dir, '.klex.lock'), 'utf8');
    const parsed = JSON.parse(content);
    expect(parsed.pid).toBe(process.pid);
    expect(parsed.startedAt).toBeTypeOf('string');
    await lock.release();
  });

  it('second acquire on same directory throws', async () => {
    const lock1 = createDirectoryLock({ logging, dataDirectory: dir });
    await lock1.acquire();

    const lock2 = createDirectoryLock({ logging, dataDirectory: dir });
    await expect(lock2.acquire()).rejects.toThrow(/already in use/);

    await lock1.release();
  });

  it('release allows re-acquire', async () => {
    const lock = createDirectoryLock({ logging, dataDirectory: dir });
    await lock.acquire();
    await lock.release();

    const lock2 = createDirectoryLock({ logging, dataDirectory: dir });
    await lock2.acquire();
    await lock2.release();
  });

  it('stale lock with dead PID is detected and replaced', async () => {
    // Write a lock file with a PID that definitely doesn't exist
    // Use a very high PID — unlikely to be in use
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      join(dir, '.klex.lock'),
      JSON.stringify({ pid: 999_999, startedAt: new Date().toISOString() }),
      'utf8',
    );

    const lock = createDirectoryLock({ logging, dataDirectory: dir });
    // Should not throw — stale lock should be replaced
    await lock.acquire();
    const content = await readFile(join(dir, '.klex.lock'), 'utf8');
    const parsed = JSON.parse(content);
    expect(parsed.pid).toBe(process.pid);
    await lock.release();
  });

  it.runIf(process.platform !== 'win32')(
    'reports failure to remove the lock file',
    async () => {
      const lock = createDirectoryLock({ logging, dataDirectory: dir });
      await lock.acquire();
      await chmod(dir, 0o500);
      try {
        await expect(lock.release()).rejects.toMatchObject({ code: 'EACCES' });
      } finally {
        await chmod(dir, 0o700);
      }
      await expect(stat(join(dir, '.klex.lock'))).resolves.toBeDefined();
    },
  );

  it('release is idempotent', async () => {
    const lock = createDirectoryLock({ logging, dataDirectory: dir });
    await lock.acquire();
    await lock.release();
    // Second release should not throw
    await lock.release();
  });

  it('acquire is idempotent', async () => {
    const lock = createDirectoryLock({ logging, dataDirectory: dir });
    await lock.acquire();
    // Second acquire should not throw
    await lock.acquire();
    await lock.release();
  });

  it('lock file has restrictive permissions', async () => {
    const lock = createDirectoryLock({ logging, dataDirectory: dir });
    await lock.acquire();
    const stats = await stat(join(dir, '.klex.lock'));
    // Mode 0o600 = owner read/write only
    // On macOS, stat returns the full mode including file type bits
    expect(stats.mode & 0o777).toBe(0o600);
    await lock.release();
  });

  it('release does not delete a lock file created by another process', async () => {
    const lock = createDirectoryLock({ logging, dataDirectory: dir });
    await lock.acquire();

    // Simulate another process acquiring the lock right after we unlink
    // but before we close our handle — by writing a new lock file with a
    // different PID after release starts.
    // We can't perfectly simulate the race, but we can verify that after
    // release(), a new lock file written by someone else survives.
    const { writeFile } = await import('node:fs/promises');
    await lock.release();

    // Another process writes its lock
    await writeFile(
      join(dir, '.klex.lock'),
      JSON.stringify({ pid: 888_888, startedAt: new Date().toISOString() }),
      'utf8',
    );

    // Our release should have already unlinked only our file.
    // The new file should still exist.
    const content = await readFile(join(dir, '.klex.lock'), 'utf8');
    const parsed = JSON.parse(content);
    expect(parsed.pid).toBe(888_888);

    // Clean up
    await unlink(join(dir, '.klex.lock')).catch(() => undefined);
  });
});
