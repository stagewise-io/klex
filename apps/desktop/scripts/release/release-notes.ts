import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

/** The body of the `## <version>` section, without its heading. */
export function extractReleaseNotes(
  changelog: string,
  version: string,
): string {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${version}`);
  if (start === -1) {
    throw new Error(`CHANGELOG.md has no "## ${version}" section`);
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^##?\s/.test(line));
  const notes = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
  if (!notes) throw new Error(`CHANGELOG.md section ${version} is empty`);
  return notes;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      output: { type: 'string' },
      version: { type: 'string' },
    },
    strict: true,
  });
  if (!values.output || !values.version) {
    throw new Error('--output and --version are required');
  }
  const changelog = readFileSync(
    new URL('../../CHANGELOG.md', import.meta.url),
    'utf8',
  );
  writeFileSync(
    values.output,
    `${extractReleaseNotes(changelog, values.version)}\n`,
  );
}
