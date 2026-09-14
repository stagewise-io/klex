import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
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

    if (bytes.includes(0)) {
      throw new Error('File appears to be binary; use encoding "base64"');
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
    const existed = await lstat(path).then(
      () => true,
      () => false,
    );
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
    if (!overwrite && (await exists(destination))) {
      throw new Error(`Destination already exists: ${destination}`);
    }
    await mkdir(dirname(destination), { recursive: true });

    if (options.move) {
      try {
        if (overwrite) await rm(destination, { force: true, recursive: true });
        await rename(source, destination);
      } catch (error) {
        if (!isErrno(error, 'EXDEV')) throw error;
        await cp(source, destination, {
          dereference: false,
          errorOnExist: !overwrite,
          force: overwrite,
          recursive: true,
        });
        await rm(source, { force: true, recursive: true });
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
      const file = await open(temporaryPath, 'wx');
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      if (process.platform === 'win32') {
        await rm(path, { force: true });
      }
      await rename(temporaryPath, path);
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  }
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

function isErrno(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
