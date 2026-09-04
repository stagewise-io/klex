import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  calculateNextStableVersion,
  extractChangelogSection,
  findLatestStableTag,
  generateChangelogSection,
  inferVersionBump,
  parseConventionalCommit,
  prependChangelog,
  readReleaseHistory,
} from './stable-release';

const commit = (
  subject: string,
  options: { breaking?: boolean; type?: string } = {},
) => ({
  body: options.breaking ? 'BREAKING CHANGE: incompatible' : '',
  breaking: options.breaking ?? false,
  ...(options.breaking ? { breakingDescription: 'incompatible' } : {}),
  hash: '1234567890abcdef',
  scope: 'klex',
  shortHash: '1234567',
  subject,
  type: options.type ?? 'fix',
});

describe('stable release versioning', () => {
  it('selects the highest stable tag and ignores nightlies', () => {
    expect(
      findLatestStableTag([
        'v0.4.0-nightly20260904c001',
        'v0.2.10',
        'v0.10.0',
        'channel-nightly',
      ]),
    ).toBe('v0.10.0');
  });

  it.each([
    [[commit('feature', { type: 'feat' })], 'minor'],
    [[commit('breaking', { breaking: true })], 'minor'],
    [[commit('bug')], 'patch'],
    [[commit('docs', { type: 'docs' })], 'patch'],
  ] as const)('infers %s as %s', (commits, expected) => {
    expect(inferVersionBump(commits)).toBe(expected);
  });

  it('rejects an empty release', () => {
    expect(() => inferVersionBump([])).toThrow('No conventional klex commits');
  });

  it.each([
    ['0.2.3', 'patch', '0.2.4'],
    ['0.2.3', 'minor', '0.3.0'],
  ] as const)('bumps %s with %s to %s', (current, bump, expected) => {
    expect(calculateNextStableVersion(current, bump)).toBe(expected);
  });

  it.each(['1.0.0', '2.3.4'])('refuses the post-1.0 version %s', (version) => {
    expect(() => calculateNextStableVersion(version, 'patch')).toThrow(
      'must remain below 1.0.0',
    );
  });

  it('parses only conventional klex commits', () => {
    expect(
      parseConventionalCommit(
        'abcdef012345',
        'feat(klex)!: replace protocol',
        'BREAKING CHANGE: old clients fail',
      ),
    ).toMatchObject({
      breaking: true,
      subject: 'replace protocol',
      type: 'feat',
    });
    expect(parseConventionalCommit('abc', 'fix(logger): nope', '')).toBeNull();
    expect(parseConventionalCommit('abc', 'not conventional', '')).toBeNull();
  });
});

describe('stable changelog', () => {
  it('groups generated notes and prepends curated text', () => {
    const section = generateChangelogSection(
      '0.2.0',
      [
        commit('break it', { breaking: true }),
        commit('add it', { type: 'feat' }),
        commit('fix it'),
        commit('speed it up', { type: 'perf' }),
      ],
      '2026-09-04',
      'Operator context.',
    );
    expect(section).toContain('Operator context.');
    expect(section).toContain('### Breaking Changes');
    expect(section).toContain('### Features');
    expect(section).toContain('### Bug Fixes');
    expect(section).toContain('### Other Changes');
  });

  it('prepends and extracts exactly one matching section', () => {
    const oldSection = generateChangelogSection(
      '0.1.0',
      [commit('old')],
      '2026-09-01',
    );
    const newSection = generateChangelogSection(
      '0.1.1',
      [commit('new')],
      '2026-09-04',
    );
    const changelog = prependChangelog(
      prependChangelog('', oldSection),
      newSection,
    );
    expect(extractChangelogSection(changelog, '0.1.1')).toBe(newSection);
    expect(() => extractChangelogSection(changelog, '0.9.9')).toThrow(
      'found 0',
    );
    expect(() =>
      extractChangelogSection(`${changelog}\n${newSection}`, '0.1.1'),
    ).toThrow('found 2');
  });
});

describe('git release history', () => {
  it('uses all history for a first release and a stable tag thereafter', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'klex-release-git-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: repo,
    });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    await mkdir(path.join(repo, 'src'));
    await writeFile(path.join(repo, 'src/file'), 'one');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'feat(klex): first'], { cwd: repo });
    expect(
      readReleaseHistory(repo).commits.map((entry) => entry.subject),
    ).toEqual(['first']);
    execFileSync('git', ['tag', 'v0.1.0'], { cwd: repo });
    execFileSync('git', ['tag', 'v0.1.1-nightly20260904c001'], { cwd: repo });
    await writeFile(path.join(repo, 'src/file'), 'two');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'fix(klex): second'], { cwd: repo });
    const history = readReleaseHistory(repo);
    expect(history.lastStableTag).toBe('v0.1.0');
    expect(history.commits.map((entry) => entry.subject)).toEqual(['second']);
    expect(await readFile(path.join(repo, 'src/file'), 'utf8')).toBe('two');
  });
});
