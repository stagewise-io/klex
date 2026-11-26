import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { type Machine, startMachine } from '../src/harness.js';

interface GlobResult {
  matches: string[];
  truncated: boolean;
}

interface GrepMatch {
  path: string;
  line: number;
  column?: number;
  text: string;
  before?: string[];
  after?: string[];
}

interface GrepResult {
  matches: GrepMatch[];
  filesSearched: number;
  truncated: boolean;
}

async function fixture(): Promise<Machine> {
  const machine = await startMachine();
  const at = (...parts: string[]) => join(machine.cwd, ...parts);
  await mkdir(at('src'), { recursive: true });
  await writeFile(at('src', 'a.ts'), 'alpha\r\nNeedle\nomega');
  await writeFile(at('src', 'ü.ts'), 'needle unicode');
  await writeFile(at('.hidden'), 'needle hidden');
  await writeFile(at('ignored.txt'), 'needle ignored');
  await writeFile(at('.gitignore'), 'ignored.txt\n');
  return machine;
}

describe('search tools', () => {
  it('globs deterministically and applies gitignore and hidden controls', async () => {
    const machine = await fixture();
    const result = await machine.tool<GlobResult>('glob', {
      patterns: ['**/*'],
    });
    expect(result).toEqual({
      matches: [
        join(machine.cwd, 'src'),
        join(machine.cwd, 'src', 'a.ts'),
        join(machine.cwd, 'src', 'ü.ts'),
      ],
      truncated: false,
    });
    const all = await machine.tool<GlobResult>('glob', {
      patterns: ['**/*'],
      gitignore: false,
      hidden: true,
    });
    expect(all.matches).toContain(join(machine.cwd, '.hidden'));
    expect(all.matches).toContain(join(machine.cwd, 'ignored.txt'));
    const excluded = await machine.tool<GlobResult>('glob', {
      patterns: ['**/*.ts'],
      exclude: ['**/ü.ts'],
    });
    expect(excluded.matches).toEqual([join(machine.cwd, 'src', 'a.ts')]);
  });

  it('does not follow directory symlinks', async () => {
    const machine = await fixture();
    await symlink(
      join(machine.cwd, 'src'),
      join(machine.cwd, 'linked-src'),
      'dir',
    );
    const result = await machine.tool<GlobResult>('glob', {
      patterns: ['**/*.ts'],
      hidden: true,
    });
    expect(result.matches).toHaveLength(2);
  });

  it('greps CRLF and Unicode text with context and include patterns', async () => {
    const machine = await fixture();
    const result = await machine.tool<GrepResult>('grepSearch', {
      pattern: 'needle',
      caseSensitive: false,
      include: ['src/**/*.ts'],
      context: 1,
    });
    expect(result.filesSearched).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.matches).toEqual([
      expect.objectContaining({
        path: join(machine.cwd, 'src', 'a.ts'),
        line: 2,
        text: 'Needle',
        before: ['alpha'],
        after: ['omega'],
      }),
      expect.objectContaining({
        path: join(machine.cwd, 'src', 'ü.ts'),
        line: 1,
        text: 'needle unicode',
      }),
    ]);
  });

  it('skips binary files and nested ignored files', async () => {
    const machine = await fixture();
    const at = (...parts: string[]) => join(machine.cwd, ...parts);
    await writeFile(
      at('binary'),
      Buffer.concat([Buffer.from([0]), Buffer.from('needle')]),
    );
    await mkdir(at('nested', 'deeper'), { recursive: true });
    await writeFile(at('nested', '.gitignore'), '*.log\n');
    await writeFile(at('nested', 'deeper', 'ignored.log'), 'needle');
    const result = await machine.tool<GrepResult>('grepSearch', {
      pattern: 'needle',
      hidden: true,
    });
    const paths = result.matches.map((match) => match.path);
    expect(paths).not.toContain(at('ignored.txt'));
    expect(paths).not.toContain(at('binary'));
    expect(paths).not.toContain(at('nested', 'deeper', 'ignored.log'));
    expect(paths).toContain(at('.hidden'));
  });

  it('applies nested gitignore anchoring, directory rules and precedence', async () => {
    const machine = await fixture();
    const at = (...parts: string[]) => join(machine.cwd, ...parts);
    await mkdir(at('nested', 'deeper', 'foo'), { recursive: true });
    await writeFile(at('nested', 'foo'), 'direct');
    await writeFile(at('nested', 'deeper', 'foo', 'file'), 'deep');
    await writeFile(at('nested', '.gitignore'), '/foo\nbar/\n');
    await mkdir(at('nested', 'bar'), { recursive: true });
    await mkdir(at('nested', 'deeper', 'bar'), { recursive: true });
    await writeFile(at('nested', 'bar', 'file'), 'direct');
    await writeFile(at('nested', 'deeper', 'bar', 'file'), 'deep');

    const anchored = await machine.tool<GlobResult>('glob', {
      patterns: ['nested/**'],
      hidden: true,
    });
    expect(anchored.matches).not.toContain(at('nested', 'foo'));
    expect(anchored.matches).toContain(at('nested', 'deeper', 'foo', 'file'));
    expect(anchored.matches).not.toContain(at('nested', 'bar'));
    expect(anchored.matches).not.toContain(
      at('nested', 'deeper', 'bar', 'file'),
    );

    await mkdir(at('-nested'), { recursive: true });
    await writeFile(at('.gitignore'), 'ignored.txt\n!-nested/keep\n');
    await writeFile(at('-nested', '.gitignore'), 'keep\n');
    await writeFile(at('-nested', 'keep'), 'hidden by child rule');
    const precedence = await machine.tool<GlobResult>('glob', {
      patterns: ['-nested/**'],
      hidden: true,
    });
    expect(precedence.matches).not.toContain(at('-nested', 'keep'));
  });

  it('reports truncation and rejects malformed or unsafe patterns', async () => {
    const machine = await fixture();
    const result = await machine.tool<GrepResult>('grepSearch', {
      pattern: 'needle',
      caseSensitive: false,
      gitignore: false,
      hidden: true,
      limit: 1,
    });
    expect(result).toMatchObject({ truncated: true });
    expect(result.matches).toHaveLength(1);
    await machine.toolError('grepSearch', { pattern: '[' });
    expect(
      await machine.toolError('grepSearch', { pattern: '(a+)+$' }),
    ).toContain('too complex');
  });
});
