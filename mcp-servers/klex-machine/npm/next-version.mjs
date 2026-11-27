// Prints the version semantic-release will give @klex/machine on this commit,
// or an empty line when there is nothing to release, and writes it to
// GITHUB_OUTPUT as `version`. The release workflow builds the platform
// binaries with this version before it releases them.

import { appendFile } from 'node:fs/promises';
import process from 'node:process';

import semanticRelease from 'semantic-release';

import config from '../.releaserc.js';

const versionPlugins = config.plugins.filter((plugin) =>
  String(Array.isArray(plugin) ? plugin[0] : plugin).endsWith(
    'scoped-release-plugin.mjs',
  ),
);
const result = await semanticRelease(
  { ...config, plugins: versionPlugins, dryRun: true },
  { stdout: process.stderr, stderr: process.stderr },
);
const version = result ? result.nextRelease.version : '';
process.stdout.write(`${version}\n`);
if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `version=${version}\n`);
}
