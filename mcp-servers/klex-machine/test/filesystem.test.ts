import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MachinePathResolver } from '../src/filesystem/paths.js';
import { FilesystemService } from '../src/filesystem/service.js';

let directory: string;
let service: FilesystemService;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'klex-machine-fs-'));
  service = new FilesystemService(new MachinePathResolver(directory));
});

afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});

describe('FilesystemService', () => {
  it('resolves relative paths and leaves absolute paths usable', () => {
    expect(service.paths.resolve('a/b')).toBe(join(directory, 'a/b'));
    expect(service.paths.resolve(join(directory, 'absolute'))).toBe(
      join(directory, 'absolute'),
    );
    expect(() => service.paths.resolve('')).toThrow('must not be empty');
  });

  it('writes, reads, and ranges UTF-8 text', async () => {
    await service.write({
      path: 'space ü/file.txt',
      content: 'one\r\ntwo\nthree',
    });
    const full = await service.read({ path: 'space ü/file.txt' });
    expect(full.content).toBe('one\r\ntwo\nthree');
    const ranged = await service.read({
      path: 'space ü/file.txt',
      startLine: 2,
      endLine: 2,
    });
    expect(ranged).toMatchObject({
      content: 'two',
      totalLines: 3,
      truncated: true,
    });
  });

  it('supports binary content through base64 and rejects malformed input', async () => {
    const content = Buffer.from([0, 1, 2, 255]).toString('base64');
    await service.write({ path: 'binary', content, encoding: 'base64' });
    await expect(service.read({ path: 'binary' })).rejects.toThrow('base64');
    await expect(
      service.read({ path: 'binary', encoding: 'base64' }),
    ).resolves.toMatchObject({ content });
    await expect(
      service.write({
        path: 'bad',
        content: 'not base64!',
        encoding: 'base64',
      }),
    ).rejects.toThrow('valid base64');
    await writeFile(join(directory, 'invalid-utf8'), Buffer.from([0xc3, 0x28]));
    await expect(service.read({ path: 'invalid-utf8' })).rejects.toThrow(
      'valid UTF-8',
    );
  });

  it('lists entries deterministically and identifies symlinks', async () => {
    await service.mkdir('dir');
    await service.write({ path: 'z.txt', content: '' });
    await service.write({ path: 'a.txt', content: 'a' });
    await symlink(join(directory, 'a.txt'), join(directory, 'link'));
    const entries = await service.list('.');
    expect(entries.map((entry) => entry.name)).toEqual([
      'a.txt',
      'dir',
      'link',
      'z.txt',
    ]);
    expect(entries.find((entry) => entry.name === 'link')?.type).toBe(
      'symlink',
    );
  });

  it('applies sequential edits atomically', async () => {
    await service.write({ path: 'edit.txt', content: 'a a b' });
    await service.multiEdit('edit.txt', [
      { oldString: 'a', newString: 'x' },
      { oldString: 'x', newString: 'y', replaceAll: true },
    ]);
    expect(await readFile(join(directory, 'edit.txt'), 'utf8')).toBe('y a b');
    await expect(
      service.multiEdit('edit.txt', [
        { oldString: 'y', newString: 'changed' },
        { oldString: 'missing', newString: 'never' },
      ]),
    ).rejects.toThrow('file was not changed');
    expect(await readFile(join(directory, 'edit.txt'), 'utf8')).toBe('y a b');
    if (process.platform !== 'win32') {
      await chmod(join(directory, 'edit.txt'), 0o600);
      await service.multiEdit('edit.txt', [
        { oldString: 'y', newString: 'private' },
      ]);
      expect((await stat(join(directory, 'edit.txt'))).mode & 0o777).toBe(
        0o600,
      );
    }
  });

  it('creates and permanently deletes directory trees', async () => {
    await expect(service.mkdir('tree/child')).resolves.toMatchObject({
      created: true,
    });
    await writeFile(join(directory, 'tree/child/file'), 'x');
    await expect(service.delete('tree')).resolves.toMatchObject({
      deleted: true,
    });
    await expect(service.delete('tree')).resolves.toMatchObject({
      deleted: false,
    });
  });

  it('copies and moves trees with explicit overwrite behavior', async () => {
    await service.write({ path: 'source/file', content: 'source' });
    await service.copy({ source: 'source', destination: 'copy' });
    expect(await readFile(join(directory, 'copy/file'), 'utf8')).toBe('source');
    await expect(
      service.copy({ source: 'source', destination: 'copy' }),
    ).rejects.toThrow('already exists');
    await service.copy({
      source: 'source',
      destination: 'moved',
      move: true,
    });
    expect(await readFile(join(directory, 'moved/file'), 'utf8')).toBe(
      'source',
    );
    await expect(readFile(join(directory, 'source/file'))).rejects.toThrow();

    await service.write({ path: 'same', content: 'preserved' });
    await service.copy({
      source: 'same',
      destination: 'same',
      move: true,
      overwrite: true,
    });
    expect(await readFile(join(directory, 'same'), 'utf8')).toBe('preserved');

    await service.write({ path: 'destination', content: 'old' });
    await expect(
      service.copy({
        source: 'missing',
        destination: 'destination',
        move: true,
        overwrite: true,
      }),
    ).rejects.toThrow();
    expect(await readFile(join(directory, 'destination'), 'utf8')).toBe('old');
  });
});
