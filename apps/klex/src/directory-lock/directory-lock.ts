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

/**
 * Lock paths held by this process. A lock file carrying our own PID is live
 * only if this process registered it; otherwise it was left by an earlier
 * process that got the same PID. That is the normal case in containers, where
 * PIDs are deterministic and a SIGKILLed run is restarted with the same PID on
 * the same volume.
 */
const heldLockPaths = new Set<string>();

/** Contents of the lock file. Unknown fields are ignored. */
interface LockRecord {
  pid?: unknown;
  /**
   * Kernel start time of the owning process (`/proc/<pid>/stat` field 22,
   * clock ticks since boot). Linux only; absent on other platforms and in
   * locks written by older Klex versions.
   */
  processStartTime?: unknown;
}

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

    // Unlink the lock file BEFORE closing the handle. If we close first,
    // another process could create a new lock file in the gap between
    // close() and unlink(), and our unlink would delete their file.
    let removeError: unknown;
    try {
      await this.safeRemoveLock();
    } catch (error) {
      removeError = error;
    }

    if (this.handle) {
      await this.handle.close().catch((error: unknown) => {
        this.deps.logger.warn({ error }, 'Failed to close lock file handle');
      });
      this.handle = null;
    }
    heldLockPaths.delete(this.deps.lockPath);
    if (removeError) throw removeError;
    this.deps.logger.debug('Working directory lock released');
  }

  private async tryAcquire(): Promise<void> {
    // O_EXCL ensures atomic creation — fails if file already exists
    const handle = await open(this.deps.lockPath, 'wx', 0o600);
    this.handle = handle;
    heldLockPaths.add(this.deps.lockPath);
    const processStartTime = await readProcessStartTime(process.pid);
    const content = JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      ...(processStartTime === undefined ? {} : { processStartTime }),
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

    let record: LockRecord;
    try {
      record = JSON.parse(content) as LockRecord;
    } catch {
      // Unparseable — stale lock
      await this.safeRemoveLock();
      return;
    }

    const pid = record?.pid;
    if (typeof pid !== 'number') {
      await this.safeRemoveLock();
      return;
    }

    if (await isLockLive(this.deps.lockPath, record)) {
      throw new Error(
        `Working directory is already in use by Klex process ${pid}. Remove the lock file at "${this.deps.lockPath}" or use a different directory.`,
      );
    }

    // Stale lock — remove it
    this.deps.logger.info(
      { lockPath: this.deps.lockPath, stalePid: pid },
      'Removing stale working directory lock',
    );
    await this.safeRemoveLock();
  }

  private async safeRemoveLock(): Promise<void> {
    try {
      await unlink(this.deps.lockPath);
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
    }
  }
}

/**
 * Whether the process named by a lock record still owns the lock. A live PID
 * alone is not proof: after a crash, containers commonly reuse low PIDs, so the
 * recorded PID may belong to an unrelated process in the new container. When
 * the lock carries a kernel start time, the PID must still have that start
 * time. Without it (older lock, non-Linux, unreadable `/proc`), a live PID is
 * trusted as before.
 */
async function isLockLive(
  lockPath: string,
  record: LockRecord,
): Promise<boolean> {
  const { pid } = record;
  if (typeof pid !== 'number') return false;
  if (pid === process.pid) return heldLockPaths.has(lockPath);
  if (!isProcessAlive(pid)) return false;
  if (typeof record.processStartTime !== 'string') return true;
  const current = await readProcessStartTime(pid);
  return current === undefined || current === record.processStartTime;
}

async function readProcessStartTime(pid: number): Promise<string | undefined> {
  if (process.platform !== 'linux') return undefined;
  try {
    return parseProcessStartTime(await readFile(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Extracts field 22 (`starttime`) from `/proc/<pid>/stat`. The second field is
 * the command name in parentheses and may itself contain spaces or `)`, so
 * fields are counted from the last `)`.
 */
export function parseProcessStartTime(stat: string): string | undefined {
  const end = stat.lastIndexOf(')');
  if (end < 0) return undefined;
  // Fields after the command name start at field 3 (state); starttime is 22.
  const value = stat
    .slice(end + 1)
    .trim()
    .split(/\s+/)[19];
  return value !== undefined && /^\d+$/.test(value) ? value : undefined;
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
    const lockPath = join(dataDirectory, LOCK_FILE_NAME);
    const content = await readFile(lockPath, 'utf8');
    return await isLockLive(lockPath, JSON.parse(content) as LockRecord);
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
