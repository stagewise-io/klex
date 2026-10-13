import { mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { createKlexAgentPackagerConfig } from '../package-exe';
import { stageDistribution } from '../release/build-artifact';

const KLEX_ROOT = resolve(import.meta.dirname, '..', '..');

/**
 * Stages a locally packaged Linux executable (`dist/`) into the container
 * build context with the same layout as a release archive. Release CI extracts
 * the published archive into the same location instead.
 */
export function stageContainerContext(outputDirectory: string): string {
  if (process.platform !== 'linux') {
    throw new Error(
      `The container image needs a Linux build; this host is ${process.platform}`,
    );
  }
  const stageDirectory = join(resolve(outputDirectory), 'klex');
  rmSync(stageDirectory, { force: true, recursive: true });
  mkdirSync(stageDirectory, { recursive: true });
  const assets = Object.keys(createKlexAgentPackagerConfig().assets ?? {});
  stageDistribution(
    join(KLEX_ROOT, 'dist'),
    stageDirectory,
    process.platform,
    assets,
  );
  return stageDirectory;
}

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((argument) => argument !== '--'),
    options: { output: { type: 'string' } },
    strict: true,
  });
  const stageDirectory = stageContainerContext(
    values.output ?? join(KLEX_ROOT, 'container', 'context'),
  );
  process.stdout.write(`Staged container context: ${stageDirectory}\n`);
}

const entryPoint = process.argv[1];
// Resolve symlinks: import.meta.url is the real path, argv[1] may not be.
if (
  entryPoint &&
  import.meta.url === pathToFileURL(realpathSync(entryPoint)).href
) {
  main();
}
