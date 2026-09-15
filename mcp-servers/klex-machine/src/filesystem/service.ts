import { isUtf8 } from 'node:buffer';
import {
  chmod,
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { MachinePathResolver } from './paths.js';

export const MAX_READ_BYTES = 1024 * 1024;
const MAX_RANGED_SOURCE_BYTES = 64 * 1024 * 1024;

export interface FileReadResult {
  path: string;
  encoding: 'utf8' | 'base64';
  content: string;
  startLine?: number;
  endLine?: number;
  totalLines?: number;
  truncated: boolean;
}

export interface DirectoryEntry {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
  modifiedAt: string;
}

export interface TextEdit {
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}

export class FilesystemService {
  constructor(readonly paths: MachinePathResolver) {}

  async read(options: {
    path: string;
    encoding?: 'utf8' | 'base64';
    startLine?: number;
    endLine?: number;
  }): Promise<FileReadResult> {
    const path = this.paths.resolve(options.path);
    const metadata = await stat(path);
    if (!metadata.isFile()) throw new Error(`Not a file: ${path}`);
    const ranged =
      options.startLine !== undefined || options.endLine !== undefined;
    if (!ranged && metadata.size > MAX_READ_BYTES) {
      throw new Error(
        `File is ${metadata.size} bytes; use startLine/endLine for text or another tool for large binary data`,
      );
    }
    if (ranged && metadata.size > MAX_RANGED_SOURCE_BYTES) {
      throw new Error(
        `File is too large for ranged reading: ${metadata.size} bytes`,
      );
    }

    const encoding = options.encoding ?? 'utf8';
    const bytes = await readFile(path);
    if (encoding === 'base64') {
      if (ranged)
        throw new Error('Line ranges are only valid with utf8 encoding');
      return {
        path,
        encoding,
        content: bytes.toString('base64'),
        truncated: false,
      };
    }

    if (bytes.includes(0) || !isUtf8(bytes)) {
      throw new Error('File is not valid UTF-8; use encoding "base64"');
    }
    const text = bytes.toString('utf8');
    if (!ranged) {
      return { path, encoding, content: text, truncated: false };
    }

    const lines = text.split(/\r?\n/);
    const startLine = options.startLine ?? 1;
    const endLine = options.endLine ?? lines.length;
    if (!Number.isInteger(startLine) || startLine < 1) {
      throw new Error('startLine must be a positive integer');
    }
    if (!Number.isInteger(endLine) || endLine < startLine) {
      throw new Error(
        'endLine must be an integer greater than or equal to startLine',
      );
    }
    const selected = lines.slice(startLine - 1, endLine);
    return {
      path,
      encoding,
      content: selected.join('\n'),
      startLine,
      endLine: Math.min(endLine, lines.length),
      totalLines: lines.length,
      truncated: endLine < lines.length,
    };
  }

  async list(pathInput: string): Promise<DirectoryEntry[]> {
    const path = this.paths.resolve(pathInput);
    const entries = await readdir(path, { withFileTypes: true });
    const results = await Promise.all(
      entries.map(async (entry) => {
        const entryPath = join(path, entry.name);
        const metadata = await lstat(entryPath);
        const type = entry.isFile()
          ? 'file'
          : entry.isDirectory()
            ? 'directory'
            : entry.isSymbolicLink()
              ? 'symlink'
              : 'other';
        return {
          name: entry.name,
          path: entryPath,
          type,
          size: metadata.size,
          modifiedAt: metadata.mtime.toISOString(),
        } satisfies DirectoryEntry;
      }),
    );
    return results.sort((left, right) => left.name.localeCompare(right.name));
  }

  async write(options: {
    path: string;
    content: string;
    encoding?: 'utf8' | 'base64';
  }): Promise<{ path: string; bytesWritten: number }> {
    const path = this.paths.resolve(options.path);
    if (options.encoding === 'base64' && !isCanonicalBase64(options.content)) {
      throw new Error('content must be valid base64');
    }
    const bytes = Buffer.from(options.content, options.encoding ?? 'utf8');
    await this.atomicWrite(path, bytes);
    return { path, bytesWritten: bytes.byteLength };
  }

  async multiEdit(
    pathInput: string,
    edits: TextEdit[],
  ): Promise<{ path: string; editsApplied: number }> {
    if (edits.length === 0) throw new Error('At least one edit is required');
    const path = this.paths.resolve(pathInput);
    let content = await readFile(path, 'utf8');
    for (const [index, edit] of edits.entries()) {
      if (edit.oldString.length === 0) {
        throw new Error(`Edit ${index + 1} has an empty oldString`);
      }
      if (!content.includes(edit.oldString)) {
        throw new Error(
          `Edit ${index + 1} did not match; file was not changed`,
        );
      }
      content = edit.replaceAll
        ? content.replaceAll(edit.oldString, edit.newString)
        : content.replace(edit.oldString, edit.newString);
    }
    await this.atomicWrite(path, Buffer.from(content));
    return { path, editsApplied: edits.length };
  }

  async mkdir(pathInput: string): Promise<{ path: string; created: boolean }> {
    const path = this.paths.resolve(pathInput);
    const existed = await lstat(path).then(
      () => true,
      () => false,
    );
    await mkdir(path, { recursive: true });
    return { path, created: !existed };
  }

  async delete(pathInput: string): Promise<{ path: string; deleted: boolean }> {
    const path = this.paths.resolve(pathInput);
    const existed = await pathExists(path);
    if (existed) await rm(path, { force: true, recursive: true });
    return { path, deleted: existed };
  }

  async copy(options: {
    source: string;
    destination: string;
    move?: boolean;
    overwrite?: boolean;
  }): Promise<{ source: string; destination: string; moved: boolean }> {
    const source = this.paths.resolve(options.source);
    const destination = this.paths.resolve(options.destination);
    const overwrite = options.overwrite ?? false;
    if (source === destination) {
      return { source, destination, moved: options.move ?? false };
    }
    await lstat(source);
    if (!overwrite && (await pathExists(destination))) {
      throw new Error(`Destination already exists: ${destination}`);
    }
    await mkdir(dirname(destination), { recursive: true });

    if (options.move) {
      try {
        if (overwrite) await replacePath(source, destination);
        else await rename(source, destination);
      } catch (error) {
        if (!isErrno(error, 'EXDEV')) throw error;
        const staging = siblingTemporaryPath(destination, 'move');
        try {
          await cp(source, staging, {
            dereference: false,
            errorOnExist: true,
            force: false,
            recursive: true,
          });
          if (overwrite) {
            await replacePath(staging, destination);
          } else {
            await publishPathExclusively(staging, destination);
          }
          await makeDirectoriesOwnerWritable(source);
          await rm(source, { force: true, recursive: true });
        } finally {
          await rm(staging, { force: true, recursive: true });
        }
      }
    } else {
      await cp(source, destination, {
        dereference: false,
        errorOnExist: !overwrite,
        force: overwrite,
        recursive: true,
      });
    }
    return { source, destination, moved: options.move ?? false };
  }

  private async atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
    const parent = dirname(path);
    await mkdir(parent, { recursive: true });
    const temporaryDirectory = await mkdtemp(join(parent, '.klex-machine-'));
    const temporaryPath = join(temporaryDirectory, 'content');
    try {
      const existing = await lstat(path).catch((error: unknown) => {
        if (isErrno(error, 'ENOENT')) return undefined;
        throw error;
      });
      if (existing && !existing.isFile() && !existing.isSymbolicLink()) {
        throw new Error(`Not a file: ${path}`);
      }
      const existingMode = existing?.isFile() ? existing.mode : 0o666;
      const file = await open(temporaryPath, 'wx', existingMode);
      try {
        if (existing?.isFile()) await file.chmod(existing.mode);
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      await replacePath(temporaryPath, path);
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    (error: unknown) => {
      if (isErrno(error, 'ENOENT')) return false;
      throw error;
    },
  );
}

async function replacePath(source: string, destination: string): Promise<void> {
  const [sourceMetadata, destinationMetadata] = await Promise.all([
    lstat(source),
    lstat(destination).catch((error: unknown) => {
      if (isErrno(error, 'ENOENT')) return undefined;
      throw error;
    }),
  ]);
  const requiresBackup =
    process.platform === 'win32' ||
    (destinationMetadata !== undefined &&
      (sourceMetadata.isDirectory() || destinationMetadata.isDirectory()));
  if (!requiresBackup) {
    await rename(source, destination);
    return;
  }

  const backup = siblingTemporaryPath(destination, 'backup');
  if (destinationMetadata) await rename(destination, backup);
  try {
    await rename(source, destination);
  } catch (error) {
    if (destinationMetadata) await rename(backup, destination);
    throw error;
  }
  if (destinationMetadata) {
    await rm(backup, { force: true, recursive: true }).catch(() => undefined);
  }
}

interface PublishedPath {
  path: string;
  device: number;
  inode: number;
  directory: boolean;
}

async function publishPathExclusively(
  source: string,
  destination: string,
): Promise<void> {
  const published: PublishedPath[] = [];
  try {
    await publishExclusiveEntry(source, destination, published);
  } catch (error) {
    await rollbackPublishedPaths(published);
    throw error;
  }
}

async function publishExclusiveEntry(
  source: string,
  destination: string,
  published: PublishedPath[],
): Promise<void> {
  const metadata = await lstat(source);
  if (metadata.isSymbolicLink()) {
    await symlink(await readlink(source), destination);
    await recordPublishedPath(destination, published);
    return;
  }
  if (!metadata.isDirectory()) {
    await link(source, destination);
    await recordPublishedPath(destination, published);
    return;
  }

  await chmod(source, metadata.mode | 0o700);
  await mkdir(destination, { mode: metadata.mode | 0o700 });
  await recordPublishedPath(destination, published);
  for (const entry of await readdir(source)) {
    await publishExclusiveEntry(
      join(source, entry),
      join(destination, entry),
      published,
    );
  }
  await chmod(destination, metadata.mode);
}

async function recordPublishedPath(
  path: string,
  published: PublishedPath[],
): Promise<void> {
  const metadata = await lstat(path);
  published.push({
    path,
    device: metadata.dev,
    inode: metadata.ino,
    directory: metadata.isDirectory(),
  });
}

async function rollbackPublishedPaths(
  published: PublishedPath[],
): Promise<void> {
  for (const entry of published.reverse()) {
    const current = await lstat(entry.path).catch(() => undefined);
    if (
      !current ||
      current.dev !== entry.device ||
      current.ino !== entry.inode
    ) {
      continue;
    }
    const remove = entry.directory ? rmdir(entry.path) : rm(entry.path);
    await remove.catch(() => undefined);
  }
}

async function makeDirectoriesOwnerWritable(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) return;
  await chmod(path, metadata.mode | 0o700);
  for (const entry of await readdir(path)) {
    await makeDirectoriesOwnerWritable(join(path, entry));
  }
}

function siblingTemporaryPath(path: string, purpose: string): string {
  return join(
    dirname(path),
    `.klex-machine-${purpose}-${process.pid}-${crypto.randomUUID()}`,
  );
}

function isCanonicalBase64(value: string): boolean {
  if (value.length === 0) return true;
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    return false;
  }
  return Buffer.from(value, 'base64').toString('base64') === value;
}

function isErrno(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
