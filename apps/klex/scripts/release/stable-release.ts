import { execFileSync } from 'node:child_process';

export type StableVersion = `${number}.${number}.${number}`;
export type VersionBump = 'minor' | 'patch';

export interface ConventionalCommit {
  readonly body: string;
  readonly breaking: boolean;
  readonly breakingDescription?: string;
  readonly hash: string;
  readonly scope: string;
  readonly shortHash: string;
  readonly subject: string;
  readonly type: string;
}

const stableVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const conventionalSubjectPattern = /^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/;

export function parseStableVersion(version: string): [number, number, number] {
  const match = stableVersionPattern.exec(version);
  if (!match) throw new Error(`Invalid stable version: ${version}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function findLatestStableTag(tags: readonly string[]): string | null {
  const stable = tags
    .map((tag) => ({ tag, version: tag.startsWith('v') ? tag.slice(1) : '' }))
    .filter((entry) => stableVersionPattern.test(entry.version))
    .sort((left, right) => {
      const leftParts = parseStableVersion(left.version);
      const rightParts = parseStableVersion(right.version);
      for (let index = 0; index < 3; index += 1) {
        const difference = (rightParts[index] ?? 0) - (leftParts[index] ?? 0);
        if (difference !== 0) return difference;
      }
      return 0;
    });
  return stable[0]?.tag ?? null;
}

export function parseConventionalCommit(
  hash: string,
  subject: string,
  body: string,
  requiredScope = 'klex',
): ConventionalCommit | null {
  const match = conventionalSubjectPattern.exec(subject);
  if (!match || match[2] !== requiredScope || !match[1] || !match[4])
    return null;
  const breakingMatch = /(?:^|\n)BREAKING CHANGE:\s*(.+)/.exec(body);
  const breaking = match[3] === '!' || breakingMatch !== null;
  return {
    hash,
    shortHash: hash.slice(0, 7),
    type: match[1],
    scope: match[2],
    subject: match[4],
    body,
    breaking,
    ...(breakingMatch?.[1]
      ? { breakingDescription: breakingMatch[1].trim() }
      : {}),
  };
}

export function parseGitLog(log: string): ConventionalCommit[] {
  return log
    .split('\u001e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash = '', subject = '', ...bodyParts] = record.split('\u001f');
      return parseConventionalCommit(
        hash.trim(),
        subject.trim(),
        bodyParts.join('\u001f').trim(),
      );
    })
    .filter((commit): commit is ConventionalCommit => commit !== null);
}

export function inferVersionBump(
  commits: readonly ConventionalCommit[],
): VersionBump {
  if (commits.length === 0) {
    throw new Error(
      'No conventional klex commits found since the last stable release',
    );
  }
  return commits.some((commit) => commit.breaking || commit.type === 'feat')
    ? 'minor'
    : 'patch';
}

export function calculateNextStableVersion(
  currentVersion: string,
  bump: VersionBump,
): StableVersion {
  const [major, minor, patch] = parseStableVersion(currentVersion);
  if (major !== 0) {
    throw new Error(
      `Automated Klex releases must remain below 1.0.0: ${currentVersion}`,
    );
  }
  const next: StableVersion =
    bump === 'minor' ? `0.${minor + 1}.0` : `0.${minor}.${patch + 1}`;
  if (parseStableVersion(next)[0] !== 0) {
    throw new Error(`Automated Klex releases must remain below 1.0.0: ${next}`);
  }
  return next;
}

function formatCommit(commit: ConventionalCommit): string {
  const marker = commit.breaking ? '**BREAKING** ' : '';
  return `- ${marker}${commit.subject} (${commit.shortHash})`;
}

export function generateChangelogSection(
  version: string,
  commits: readonly ConventionalCommit[],
  date: string,
  customNotes: string | null = null,
): string {
  parseStableVersion(version);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    Number.isNaN(Date.parse(`${date}T00:00:00Z`)) ||
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date
  ) {
    throw new Error(`Invalid changelog date: ${date}`);
  }
  const breaking = commits.filter((commit) => commit.breaking);
  const features = commits.filter(
    (commit) => commit.type === 'feat' && !commit.breaking,
  );
  const fixes = commits.filter(
    (commit) => commit.type === 'fix' && !commit.breaking,
  );
  const other = commits.filter(
    (commit) =>
      !commit.breaking && commit.type !== 'feat' && commit.type !== 'fix',
  );
  let output = `## ${version} (${date})\n\n`;
  if (customNotes?.trim()) output += `${customNotes.trim()}\n\n`;
  const groups: ReadonlyArray<
    readonly [string, readonly ConventionalCommit[]]
  > = [
    ['Breaking Changes', breaking],
    ['Features', features],
    ['Bug Fixes', fixes],
    ['Other Changes', other],
  ];
  for (const [heading, entries] of groups) {
    if (entries.length === 0) continue;
    output += `### ${heading}\n\n${entries.map(formatCommit).join('\n')}\n\n`;
  }
  return `${output.trimEnd()}\n`;
}

export function prependChangelog(existing: string, section: string): string {
  const body = section.trimEnd();
  if (!existing.trim()) {
    return `# Changelog\n\nAll notable Klex changes are documented here.\n\n${body}\n`;
  }
  if (!existing.startsWith('# Changelog')) {
    throw new Error('Existing changelog must start with "# Changelog"');
  }
  const firstSection = existing.indexOf('\n## ');
  if (firstSection === -1) return `${existing.trimEnd()}\n\n${body}\n`;
  return `${existing.slice(0, firstSection).trimEnd()}\n\n${body}\n\n${existing
    .slice(firstSection + 1)
    .trimStart()}`;
}

export function extractChangelogSection(
  changelog: string,
  version: string,
): string {
  parseStableVersion(version);
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [
    ...changelog.matchAll(
      new RegExp(
        `^## ${escaped} \\(\\d{4}-\\d{2}-\\d{2}\\)\\n[\\s\\S]*?(?=^## (?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*) \\(\\d{4}-\\d{2}-\\d{2}\\)$|(?![\\s\\S]))`,
        'gm',
      ),
    ),
  ];
  if (matches.length !== 1 || !matches[0]?.[0]) {
    throw new Error(
      `Expected exactly one changelog section for ${version}, found ${matches.length}`,
    );
  }
  return `${matches[0][0].trim()}\n`;
}

export function readReleaseHistory(cwd: string): {
  readonly commits: ConventionalCommit[];
  readonly lastStableTag: string | null;
} {
  const tags = execFileSync('git', ['tag', '--list', 'v*'], {
    cwd,
    encoding: 'utf8',
  })
    .split('\n')
    .map((tag) => tag.trim())
    .filter(Boolean);
  const lastStableTag = findLatestStableTag(tags);
  const range = lastStableTag ? `${lastStableTag}..HEAD` : 'HEAD';
  const log = execFileSync(
    'git',
    ['log', range, '--no-merges', '--format=%H%x1f%s%x1f%b%x1e'],
    { cwd, encoding: 'utf8' },
  );
  return { commits: parseGitLog(log), lastStableTag };
}
