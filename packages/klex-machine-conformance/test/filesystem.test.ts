import {
  chmod,
  lstat,
  mkdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { startMachine, windows } from '../src/harness.js';

interface ReadResult {
  path: string;
  content: string;
  encoding: string;
  totalLines?: number;
  truncated?: boolean;
}

interface ListEntry {
  name: string;
  path: string;
  type: string;
  size: number;
  modifiedAt: string;
}

describe('filesystem tools', () => {
  it('writes, reads and ranges UTF-8 text relative to the cwd', async () => {
    const machine = await startMachine();
    await machine.tool('write', {
      path: 'space ü/file.txt',
      content: 'one\r\ntwo\nthree',
    });
    const full = await machine.tool<ReadResult>('read', {
      path: 'space ü/file.txt',
    });
    expect(full).toMatchObject({
      path: join(machine.cwd, 'space ü', 'file.txt'),
      content: 'one\r\ntwo\nthree',
    });
    const ranged = await machine.tool<ReadResult>('read', {
      path: 'space ü/file.txt',
      startLine: 2,
      endLine: 2,
    });
    expect(ranged).toMatchObject({
      content: 'two',
      totalLines: 3,
      truncated: true,
    });
    const absolute = await machine.tool<ReadResult>('read', {
      path: join(machine.cwd, 'space ü', 'file.txt'),
    });
    expect(absolute.content).toBe(full.content);
  });

  it('round-trips binary content through base64 and rejects bad input', async () => {
    const machine = await startMachine();
    const content = Buffer.from([0, 1, 2, 255]).toString('base64');
    await machine.tool('write', {
      path: 'binary',
      content,
      encoding: 'base64',
    });
    expect(await machine.toolError('read', { path: 'binary' })).toContain(
      'base64',
    );
    await expect(
      machine.tool('read', { path: 'binary', encoding: 'base64' }),
    ).resolves.toMatchObject({ content, encoding: 'base64' });
    expect(
      await machine.toolError('write', {
        path: 'bad',
        content: 'not base64!',
        encoding: 'base64',
      }),
    ).toContain('valid base64');
    await writeFile(
      join(machine.cwd, 'invalid-utf8'),
      Buffer.from([0xc3, 0x28]),
    );
    expect(await machine.toolError('read', { path: 'invalid-utf8' })).toContain(
      'valid UTF-8',
    );
  });

  it('reports missing files with Node-style errors', async () => {
    const machine = await startMachine();
    const missing = join(machine.cwd, 'missing.txt');
    expect(await machine.toolError('read', { path: 'missing.txt' })).toBe(
      `Error: ENOENT: no such file or directory, stat '${missing}'`,
    );
  });

  it('lists entries deterministically and identifies symlinks', async () => {
    const machine = await startMachine();
    await machine.tool('mkdir', { path: 'dir' });
    await machine.tool('write', { path: 'z.txt', content: '' });
    await machine.tool('write', { path: 'a.txt', content: 'a' });
    await machine.tool('write', { path: 'B.txt', content: 'b' });
    await symlink(join(machine.cwd, 'a.txt'), join(machine.cwd, 'link'));
    const entries = await machine.tool<ListEntry[]>('list', { path: '.' });
    expect(entries.map((entry) => entry.name)).toEqual([
      'a.txt',
      'B.txt',
      'dir',
      'link',
      'z.txt',
    ]);
    expect(entries.find((entry) => entry.name === 'link')?.type).toBe(
      'symlink',
    );
    expect(entries.find((entry) => entry.name === 'a.txt')).toMatchObject({
      path: join(machine.cwd, 'a.txt'),
      type: 'file',
      size: 1,
    });
    expect(
      entries.every((entry) => !Number.isNaN(Date.parse(entry.modifiedAt))),
    ).toBe(true);
  });

  it('refuses to replace a directory with file content', async () => {
    const machine = await startMachine();
    await machine.tool('write', {
      path: 'target/child/file',
      content: 'preserved',
    });
    expect(
      await machine.toolError('write', { path: 'target', content: 'x' }),
    ).toContain('Not a file');
    await expect(
      readFile(join(machine.cwd, 'target/child/file'), 'utf8'),
    ).resolves.toBe('preserved');
  });

  it('replaces symlinks without copying their mode to the new file', async () => {
    const machine = await startMachine();
    await machine.tool('write', { path: 'source', content: 'source' });
    await chmod(join(machine.cwd, 'source'), 0o777);
    await symlink(
      join(machine.cwd, 'source'),
      join(machine.cwd, 'link'),
      'file',
    );
    await machine.tool('write', { path: 'link', content: 'replacement' });
    const link = await lstat(join(machine.cwd, 'link'));
    expect(link.isFile()).toBe(true);
    // Windows has no POSIX mode bits to copy.
    if (!windows) expect(link.mode & 0o777).not.toBe(0o777);
    expect(await readFile(join(machine.cwd, 'link'), 'utf8')).toBe(
      'replacement',
    );
    expect(await readFile(join(machine.cwd, 'source'), 'utf8')).toBe('source');
  });

  it('applies sequential edits atomically', async () => {
    const machine = await startMachine();
    await machine.tool('write', { path: 'edit.txt', content: 'a a b' });
    await machine.tool('multiEdit', {
      path: 'edit.txt',
      edits: [
        { oldString: 'a', newString: 'x' },
        { oldString: 'x', newString: 'y', replaceAll: true },
      ],
    });
    expect(await readFile(join(machine.cwd, 'edit.txt'), 'utf8')).toBe('y a b');
    expect(
      await machine.toolError('multiEdit', {
        path: 'edit.txt',
        edits: [
          { oldString: 'y', newString: 'changed' },
          { oldString: 'missing', newString: 'never' },
        ],
      }),
    ).toContain('file was not changed');
    expect(await readFile(join(machine.cwd, 'edit.txt'), 'utf8')).toBe('y a b');
    if (!windows) {
      await chmod(join(machine.cwd, 'edit.txt'), 0o600);
      await machine.tool('multiEdit', {
        path: 'edit.txt',
        edits: [{ oldString: 'y', newString: 'private' }],
      });
      expect((await stat(join(machine.cwd, 'edit.txt'))).mode & 0o777).toBe(
        0o600,
      );
    }
  });

  it('creates and permanently deletes directory trees', async () => {
    const machine = await startMachine();
    await expect(
      machine.tool('mkdir', { path: 'tree/child' }),
    ).resolves.toMatchObject({ created: true });
    await expect(
      machine.tool('mkdir', { path: 'tree/child' }),
    ).resolves.toMatchObject({ created: false });
    await writeFile(join(machine.cwd, 'tree/child/file'), 'x');
    await expect(
      machine.tool('delete', { path: 'tree' }),
    ).resolves.toMatchObject({ deleted: true });
    await expect(
      machine.tool('delete', { path: 'tree' }),
    ).resolves.toMatchObject({ deleted: false });
  });

  it('copies and moves trees with explicit overwrite behavior', async () => {
    const machine = await startMachine();
    const at = (path: string) => join(machine.cwd, path);
    await machine.tool('write', { path: 'source/file', content: 'source' });
    await machine.tool('copy', { source: 'source', destination: 'copy' });
    expect(await readFile(at('copy/file'), 'utf8')).toBe('source');
    expect(
      await machine.toolError('copy', {
        source: 'source',
        destination: 'copy',
      }),
    ).toContain('already exists');
    await machine.tool('copy', {
      source: 'source',
      destination: 'moved',
      move: true,
    });
    expect(await readFile(at('moved/file'), 'utf8')).toBe('source');
    await expect(readFile(at('source/file'))).rejects.toThrow();

    await machine.tool('write', { path: 'same', content: 'preserved' });
    await machine.tool('copy', {
      source: 'same',
      destination: 'same',
      move: true,
      overwrite: true,
    });
    expect(await readFile(at('same'), 'utf8')).toBe('preserved');

    await machine.tool('write', { path: 'destination', content: 'old' });
    await machine.toolError('copy', {
      source: 'missing',
      destination: 'destination',
      move: true,
      overwrite: true,
    });
    expect(await readFile(at('destination'), 'utf8')).toBe('old');
  });

  it('replaces a non-empty destination directory when moving with overwrite', async () => {
    const machine = await startMachine();
    const at = (path: string) => join(machine.cwd, path);
    await machine.tool('write', { path: 'source/new', content: 'new' });
    await machine.tool('write', { path: 'destination/old', content: 'old' });
    await machine.tool('copy', {
      source: 'source',
      destination: 'destination',
      move: true,
      overwrite: true,
    });
    await expect(readFile(at('destination/new'), 'utf8')).resolves.toBe('new');
    await expect(readFile(at('destination/old'))).rejects.toThrow();
    await expect(readFile(at('source/new'))).rejects.toThrow();
  });

  it('copies symlinks as links', async () => {
    const machine = await startMachine();
    await mkdir(join(machine.cwd, 'tree'));
    await writeFile(join(machine.cwd, 'tree', 'target'), 'data');
    await symlink('target', join(machine.cwd, 'tree', 'link'));
    await machine.tool('copy', { source: 'tree', destination: 'copy' });
    const entries = await machine.tool<ListEntry[]>('list', { path: 'copy' });
    expect(entries.find((entry) => entry.name === 'link')?.type).toBe(
      'symlink',
    );
  });
});
