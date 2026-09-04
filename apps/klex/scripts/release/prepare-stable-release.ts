import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import {
  calculateNextStableVersion,
  extractChangelogSection,
  generateChangelogSection,
  inferVersionBump,
  prependChangelog,
  readReleaseHistory,
} from './stable-release';

interface PackageJson {
  version: string;
  [key: string]: unknown;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function writeGithubOutput(
  outputPath: string,
  values: Readonly<Record<string, string>>,
): Promise<void> {
  const delimiter = `KLEX_RELEASE_${Date.now()}`;
  const lines = Object.entries(values).flatMap(([key, value]) =>
    value.includes('\n')
      ? [`${key}<<${delimiter}`, value.trimEnd(), delimiter]
      : [`${key}=${value}`],
  );
  await writeFile(outputPath, `${lines.join('\n')}\n`, { flag: 'a' });
}

export async function prepareStableRelease(options: {
  readonly date: string;
  readonly githubOutput?: string;
  readonly repoRoot: string;
}): Promise<{
  readonly bump: string;
  readonly notes: string;
  readonly tag: string;
  readonly version: string;
}> {
  const packagePath = path.join(options.repoRoot, 'apps/klex/package.json');
  const changelogPath = path.join(options.repoRoot, 'apps/klex/CHANGELOG.md');
  const customNotesPath = path.join(options.repoRoot, '.release-notes/klex.md');
  const packageJson = JSON.parse(
    await readFile(packagePath, 'utf8'),
  ) as PackageJson;
  const { commits } = readReleaseHistory(options.repoRoot);
  const bump = inferVersionBump(commits);
  const version = calculateNextStableVersion(packageJson.version, bump);
  const customNotes = await readFile(customNotesPath, 'utf8').catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    },
  );
  const section = generateChangelogSection(
    version,
    commits,
    options.date,
    customNotes,
  );
  const existingChangelog = await readFile(changelogPath, 'utf8').catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    },
  );
  packageJson.version = version;
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  await writeFile(changelogPath, prependChangelog(existingChangelog, section));
  if (customNotes !== null) await rm(customNotesPath);

  const result = {
    bump,
    notes: extractChangelogSection(
      await readFile(changelogPath, 'utf8'),
      version,
    ),
    tag: `v${version}`,
    version,
  };
  if (options.githubOutput) {
    await writeGithubOutput(options.githubOutput, result);
  }
  return result;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      date: { type: 'string' },
      'github-output': { type: 'string' },
      'repo-root': { type: 'string' },
    },
    strict: true,
  });
  const repoRoot = path.resolve(values['repo-root'] ?? process.cwd());
  const result = await prepareStableRelease({
    date: values.date ?? formatDate(new Date()),
    repoRoot,
    ...(values['github-output']
      ? { githubOutput: values['github-output'] }
      : {}),
  });
  if (!values['github-output'])
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.url === new URL(process.argv[1] ?? '', 'file:').href) {
  await main();
}
