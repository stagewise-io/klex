import { type FileHandle, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import type { ModuleLogger, RootLogger } from '@stagewise/logger';

export interface DirectoryLock {
  acquire(): Promise<void>;
  release(): Promise<void>;
}

export interface DirectoryLockDependencies {
  logging: RootLogger;
  dataDirectory: string;
}

const LOCK_FILE_NAME = '.klex.lock';

class DirectoryLockModule implements DirectoryLock {
  private handle: FileHandle | null = null;
  private acquired = false;

  constructor(
    private readonly deps: {
      logger: ModuleLogger;
      lockPath: string;
    },
  ) {}

  async acquire(): Promise<void> {
    if (this.acquired) return;

    try {
      await this.tryAcquire();
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
      await this.handleExistingLock();
      // Retry once after handling stale lock
      await this.tryAcquire();
    }

    this.acquired = true;
    this.deps.logger.info(
      { lockPath: this.deps.lockPath },
      'Working directory locked',
    );
  }

  async release(): Promise<void> {
    if (!this.acquired) return;
    this.acquired = false;

    // Unlink the lock file BEFORE closing the handle.  If we close first,
    // another process could create a new lock file in the gap between
    // close() and unlink(), and our unlink would delete their file.
    await this.safeRemoveLock();

    if (this.handle) {
      await this.handle.close().catch((error: unknown) => {
        this.deps.logger.warn({ error }, 'Failed to close lock file handle');
      });
      this.handle = null;
    }
    this.deps.logger.debug('Working directory lock released');
  }

  private async tryAcquire(): Promise<void> {
    // O_EXCL ensures atomic creation — fails if file already exists
    const handle = await open(this.deps.lockPath, 'wx', 0o600);
    this.handle = handle;
    const content = JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });
    await handle.writeFile(content, 'utf8');
    // Keep the handle open — the open fd is part of the lock
  }

  private async handleExistingLock(): Promise<void> {
    let content: string;
    try {
      content = await readFile(this.deps.lockPath, 'utf8');
    } catch {
      // Can't read — try to remove and let retry handle it
      await this.safeRemoveLock();
      return;
    }

    let pid: number | undefined;
    try {
      pid = (JSON.parse(content) as { pid?: number }).pid;
    } catch {
      // Unparseable — stale lock
      await this.safeRemoveLock();
      return;
    }

    if (pid === undefined) {
      await this.safeRemoveLock();
      return;
    }

    if (isProcessAlive(pid)) {
      throw new Error(
        `Working directory is already in use by Klex process ${pid}. Remove the lock file at "${this.deps.lockPath}" or use a different directory.`,
      );
    }

    // Stale lock — remove it
    await this.safeRemoveLock();
  }

  private async safeRemoveLock(): Promise<void> {
    await unlink(this.deps.lockPath).catch(() => undefined);
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error)) {
      // ESRCH = no such process, EPERM = process exists but different user
      return error.code === 'EPERM';
    }
    return false;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

/** Returns whether a live Klex process currently owns this directory lock. */
export async function isDirectoryInUse(
  dataDirectory: string,
): Promise<boolean> {
  try {
    const content = await readFile(join(dataDirectory, LOCK_FILE_NAME), 'utf8');
    const pid = (JSON.parse(content) as { pid?: unknown }).pid;
    return typeof pid === 'number' && isProcessAlive(pid);
  } catch {
    return false;
  }
}

export function createDirectoryLock(
  deps: DirectoryLockDependencies,
): DirectoryLock {
  return new DirectoryLockModule({
    logger: deps.logging.child({
      name: 'directory-lock',
      bindings: { module: 'directory-lock' },
    }),
    lockPath: join(deps.dataDirectory, LOCK_FILE_NAME),
  });
}
