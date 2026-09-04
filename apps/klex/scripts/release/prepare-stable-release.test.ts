import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { prepareStableRelease } from './prepare-stable-release';

async function createRepository(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), 'klex-prepare-'));
  await mkdir(path.join(repo, 'apps/klex'), { recursive: true });
  await mkdir(path.join(repo, '.release-notes'), { recursive: true });
  await writeFile(
    path.join(repo, 'apps/klex/package.json'),
    '{\n  "name": "@stagewise/klex",\n  "version": "0.1.0"\n}\n',
  );
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: repo,
  });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'chore(klex): initialize'], {
    cwd: repo,
  });
  execFileSync('git', ['tag', 'v0.1.0'], { cwd: repo });
  await writeFile(path.join(repo, 'change'), 'change');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'feat(klex): useful feature'], {
    cwd: repo,
  });
  return repo;
}

describe('prepare stable release', () => {
  it('updates package and changelog, consumes notes, and writes outputs', async () => {
    const repo = await createRepository();
    const output = path.join(repo, 'github-output');
    await writeFile(
      path.join(repo, '.release-notes/klex.md'),
      'Important operator note.\n',
    );
    const result = await prepareStableRelease({
      date: '2026-09-04',
      githubOutput: output,
      repoRoot: repo,
    });
    expect(result).toMatchObject({
      bump: 'minor',
      tag: 'v0.2.0',
      version: '0.2.0',
    });
    expect(result.notes).toContain('Important operator note.');
    expect(
      JSON.parse(
        await readFile(path.join(repo, 'apps/klex/package.json'), 'utf8'),
      ).version,
    ).toBe('0.2.0');
    expect(
      await readFile(path.join(repo, 'apps/klex/CHANGELOG.md'), 'utf8'),
    ).toContain('## 0.2.0 (2026-09-04)');
    await expect(
      stat(path.join(repo, '.release-notes/klex.md')),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readFile(output, 'utf8')).toContain('version=0.2.0');
  });
});
