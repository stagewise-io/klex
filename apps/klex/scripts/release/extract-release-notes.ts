import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { extractChangelogSection } from './stable-release';

const { values } = parseArgs({
  args: process.argv
    .slice(2)
    .filter((argument, index) => index > 0 || argument !== '--'),
  options: {
    changelog: { type: 'string' },
    output: { type: 'string' },
    version: { type: 'string' },
  },
  strict: true,
});
if (!values.changelog || !values.output || !values.version) {
  throw new Error('--changelog, --output, and --version are required');
}
const changelog = await readFile(values.changelog, 'utf8');
await writeFile(
  values.output,
  extractChangelogSection(changelog, values.version),
);
