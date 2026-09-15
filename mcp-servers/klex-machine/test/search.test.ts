import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MachinePathResolver } from '../src/filesystem/paths.js';
import { SearchService } from '../src/filesystem/search.js';

let directory: string;
let service: SearchService;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'klex-machine-search-'));
  service = new SearchService(new MachinePathResolver(directory));
  await mkdir(join(directory, 'src'), { recursive: true });
  await writeFile(join(directory, 'src', 'a.ts'), 'alpha\r\nNeedle\nomega');
  await writeFile(join(directory, 'src', 'ü.ts'), 'needle unicode');
  await writeFile(join(directory, '.hidden'), 'needle hidden');
  await writeFile(join(directory, 'ignored.txt'), 'needle ignored');
  await writeFile(join(directory, '.gitignore'), 'ignored.txt\n');
});

afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});

describe('SearchService', () => {
  it('globs deterministically and applies gitignore and hidden controls', async () => {
    const result = await service.glob({ patterns: ['**/*'] });
    expect(
      result.matches.map((path) => path.slice(directory.length + 1)),
    ).toEqual(['src', join('src', 'a.ts'), join('src', 'ü.ts')]);
    const all = await service.glob({
      patterns: ['**/*'],
      gitignore: false,
      hidden: true,
    });
    expect(all.matches).toContain(join(directory, '.hidden'));
    expect(all.matches).toContain(join(directory, 'ignored.txt'));
  });

  it('does not follow directory symlinks', async () => {
    await symlink(join(directory, 'src'), join(directory, 'linked-src'), 'dir');
    const result = await service.glob({ patterns: ['**/*.ts'], hidden: true });
    expect(result.matches).toHaveLength(2);
  });

  it('greps CRLF and Unicode text with context and include patterns', async () => {
    const result = await service.grep({
      pattern: 'needle',
      caseSensitive: false,
      include: ['src/**/*.ts'],
      context: 1,
    });
    expect(result.filesSearched).toBe(2);
    expect(result.matches).toHaveLength(2);
    expect(result.matches[0]).toMatchObject({
      line: 2,
      text: 'Needle',
      before: ['alpha'],
      after: ['omega'],
    });
  });

  it('skips binary files and nested ignored files', async () => {
    await writeFile(
      join(directory, 'binary'),
      Buffer.concat([Buffer.from([0]), Buffer.from('needle')]),
    );
    await mkdir(join(directory, 'nested', 'deeper'), { recursive: true });
    await writeFile(join(directory, 'nested', '.gitignore'), '*.log\n');
    await writeFile(
      join(directory, 'nested', 'deeper', 'ignored.log'),
      'needle',
    );
    const result = await service.grep({ pattern: 'needle', hidden: true });
    const paths = result.matches.map((match) => match.path);
    expect(paths).not.toContain(join(directory, 'ignored.txt'));
    expect(paths).not.toContain(join(directory, 'binary'));
    expect(paths).not.toContain(
      join(directory, 'nested', 'deeper', 'ignored.log'),
    );
    expect(result.filesSearched).toBeGreaterThan(0);
  });

  it('reports truncation and rejects malformed inputs', async () => {
    const result = await service.grep({
      pattern: 'needle',
      caseSensitive: false,
      gitignore: false,
      hidden: true,
      limit: 1,
    });
    expect(result).toMatchObject({ truncated: true });
    await expect(service.grep({ pattern: '[' })).rejects.toThrow();
    await expect(service.grep({ pattern: '(a+)+$' })).rejects.toThrow(
      'too complex',
    );
    await expect(
      service.glob({ patterns: ['**/*'], limit: 0 }),
    ).rejects.toThrow('limit');
  });
});
