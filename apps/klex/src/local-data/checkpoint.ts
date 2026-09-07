import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { createClient } from '@libsql/client';
import { z } from 'zod';

import type { StoreInspection } from './types';

const ROOT_NAME = '.klex-migrations';
const manifestSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  status: z.enum(['pending', 'successful', 'failed']),
  entries: z.array(
    z.object({
      storeId: z.string(),
      kind: z.enum(['json', 'sqlite']),
      relativePath: z.string(),
      existed: z.boolean(),
      backupName: z.string().optional(),
      mode: z.number().int().optional(),
      size: z.number().int().optional(),
      sha256: z.string().optional(),
    }),
  ),
});

type CheckpointManifest = z.infer<typeof manifestSchema>;

const journalSchema = z.object({
  checkpointId: z.string(),
  startedAt: z.string(),
});

export async function createCheckpoint(
  dataDirectory: string,
  inspections: readonly StoreInspection[],
): Promise<CheckpointManifest> {
  const id = `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID()}`;
  const root = migrationRoot(dataDirectory);
  const staging = join(root, 'checkpoints', `${id}.tmp`);
  const finalPath = join(root, 'checkpoints', id);
  await mkdir(join(staging, 'files'), { recursive: true, mode: 0o700 });
  const entries: CheckpointManifest['entries'] = [];
  try {
    for (const [index, inspection] of inspections.entries()) {
      if (!inspection.exists) {
        entries.push({
          storeId: inspection.definition.id,
          kind: inspection.definition.kind,
          relativePath: inspection.definition.relativePath,
          existed: false,
        });
        continue;
      }
      if (inspection.definition.kind === 'sqlite')
        await checkpointWal(inspection.path);
      const details = await stat(inspection.path);
      const backupName = `files/${index}`;
      const backupPath = join(staging, backupName);
      await copyFile(inspection.path, backupPath);
      await chmod(backupPath, details.mode & 0o777);
      entries.push({
        storeId: inspection.definition.id,
        kind: inspection.definition.kind,
        relativePath: inspection.definition.relativePath,
        existed: true,
        backupName,
        mode: details.mode & 0o777,
        size: details.size,
        sha256: await hashFile(backupPath),
      });
    }
    const manifest: CheckpointManifest = {
      id,
      createdAt: new Date().toISOString(),
      status: 'pending',
      entries,
    };
    await writeAtomicJson(join(staging, 'manifest.json'), manifest);
    await rename(staging, finalPath);
    await writeAtomicJson(join(root, 'journal.json'), {
      checkpointId: id,
      startedAt: new Date().toISOString(),
    });
    return manifest;
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw new Error('Could not create local-data recovery checkpoint', {
      cause: error,
    });
  }
}

export async function restoreCheckpoint(
  dataDirectory: string,
  checkpointId: string,
): Promise<void> {
  const checkpointPath = join(
    migrationRoot(dataDirectory),
    'checkpoints',
    checkpointId,
  );
  const manifest = await readManifest(checkpointPath);
  for (const entry of manifest.entries) {
    assertSafeRelativePath(entry.relativePath);
    const target = join(dataDirectory, entry.relativePath);
    if (!entry.existed) {
      await removeStoreFiles(target, entry.kind);
      continue;
    }
    if (!entry.backupName || !entry.sha256 || entry.mode === undefined)
      throw new Error(`Checkpoint ${checkpointId} has an incomplete manifest`);
    const source = join(checkpointPath, entry.backupName);
    if ((await hashFile(source)) !== entry.sha256)
      throw new Error(
        `Checkpoint ${checkpointId} failed integrity verification`,
      );
    await removeStoreFiles(target, entry.kind);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(source, target);
    await chmod(target, entry.mode);
    if ((await hashFile(target)) !== entry.sha256)
      throw new Error(`Restored store ${entry.storeId} failed verification`);
  }
}

export async function recoverInterruptedMigration(
  dataDirectory: string,
): Promise<boolean> {
  const journalPath = join(migrationRoot(dataDirectory), 'journal.json');
  let raw: string;
  try {
    raw = await readFile(journalPath, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false;
    throw error;
  }
  const journal = journalSchema.parse(JSON.parse(raw));
  await restoreCheckpoint(dataDirectory, journal.checkpointId);
  await setCheckpointStatus(dataDirectory, journal.checkpointId, 'failed');
  await rm(journalPath, { force: true });
  return true;
}

export async function finishCheckpoint(
  dataDirectory: string,
  checkpointId: string,
  status: 'successful' | 'failed',
): Promise<void> {
  await setCheckpointStatus(dataDirectory, checkpointId, status);
  await rm(join(migrationRoot(dataDirectory), 'journal.json'), { force: true });
}

export async function pruneCheckpoints(dataDirectory: string): Promise<void> {
  const checkpointsPath = join(migrationRoot(dataDirectory), 'checkpoints');
  let directories: string[];
  try {
    directories = await readdir(checkpointsPath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return;
    throw error;
  }
  const manifests = await Promise.all(
    directories
      .filter((entry) => !entry.endsWith('.tmp'))
      .map(async (entry) => ({
        directory: entry,
        manifest: await readManifest(join(checkpointsPath, entry)),
      })),
  );
  const successful = manifests
    .filter((entry) => entry.manifest.status === 'successful')
    .sort((a, b) => b.manifest.createdAt.localeCompare(a.manifest.createdAt));
  const failed = manifests
    .filter((entry) => entry.manifest.status === 'failed')
    .sort((a, b) => b.manifest.createdAt.localeCompare(a.manifest.createdAt));
  const keep = new Set([
    ...successful.slice(0, 3).map((entry) => entry.directory),
    ...failed.slice(0, 1).map((entry) => entry.directory),
  ]);
  await Promise.all(
    manifests
      .filter((entry) => !keep.has(entry.directory))
      .map((entry) =>
        rm(join(checkpointsPath, entry.directory), {
          recursive: true,
          force: true,
        }),
      ),
  );
}

export function checkpointDirectory(
  dataDirectory: string,
  checkpointId: string,
): string {
  return join(migrationRoot(dataDirectory), 'checkpoints', checkpointId);
}

async function setCheckpointStatus(
  dataDirectory: string,
  checkpointId: string,
  status: 'successful' | 'failed',
): Promise<void> {
  const checkpointPath = join(
    migrationRoot(dataDirectory),
    'checkpoints',
    checkpointId,
  );
  const manifest = await readManifest(checkpointPath);
  await writeAtomicJson(join(checkpointPath, 'manifest.json'), {
    ...manifest,
    status,
  });
}

async function readManifest(
  checkpointPath: string,
): Promise<CheckpointManifest> {
  return manifestSchema.parse(
    JSON.parse(await readFile(join(checkpointPath, 'manifest.json'), 'utf8')),
  );
}

async function checkpointWal(filePath: string): Promise<void> {
  const client = createClient({ url: `file:${filePath}` });
  try {
    await client.execute('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    client.close();
  }
}

async function removeStoreFiles(
  filePath: string,
  kind: 'json' | 'sqlite',
): Promise<void> {
  await rm(filePath, { force: true });
  if (kind === 'sqlite') {
    await rm(`${filePath}-wal`, { force: true });
    await rm(`${filePath}-shm`, { force: true });
  }
}

async function hashFile(filePath: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(filePath))
    .digest('hex');
}

async function writeAtomicJson(
  filePath: string,
  value: Record<string, unknown>,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
    });
    await chmod(temporary, 0o600);
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function migrationRoot(dataDirectory: string): string {
  return join(dataDirectory, ROOT_NAME);
}

function assertSafeRelativePath(relativePath: string): void {
  if (
    relativePath.startsWith('/') ||
    relativePath.startsWith('../') ||
    relativePath.includes('/../') ||
    relativePath.includes('\\')
  )
    throw new Error(`Unsafe checkpoint path: ${relativePath}`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
