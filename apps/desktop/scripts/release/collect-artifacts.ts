import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { assetName, findTarget, type ReleaseTarget } from './targets.ts';

export interface TargetMetadata {
  readonly target: string;
  readonly version: string;
  readonly files: readonly string[];
  readonly updates: readonly {
    readonly installer: string;
    readonly file: string;
    readonly signature: string;
  }[];
}

export function metadataName(target: string): string {
  return `target-${target}.json`;
}

/**
 * Copies one target's Tauri bundles to their published names and records
 * the updater signatures next to them for the aggregate job.
 */
export function collectArtifacts(options: {
  readonly bundleDirectory: string;
  readonly outputDirectory: string;
  readonly target: ReleaseTarget;
  readonly version: string;
}): TargetMetadata {
  mkdirSync(options.outputDirectory, { recursive: true });
  const files: string[] = [];
  const updates: TargetMetadata['updates'][number][] = [];
  for (const bundle of options.target.bundles) {
    const directory = join(options.bundleDirectory, bundle.directory);
    const matches = readdirSync(directory, { withFileTypes: true }).filter(
      (entry) => entry.isFile() && entry.name.endsWith(bundle.sourceSuffix),
    );
    if (matches.length !== 1) {
      throw new Error(
        `Expected one *${bundle.sourceSuffix} in ${directory}, found ${matches.length}`,
      );
    }
    const source = join(directory, String(matches[0]?.name));
    const name = assetName(options.version, options.target, bundle);
    copyFileSync(source, join(options.outputDirectory, name));
    files.push(name);
    if (bundle.installer) {
      updates.push({
        installer: bundle.installer,
        file: name,
        signature: readFileSync(`${source}.sig`, 'utf8').trim(),
      });
    }
  }
  const metadata: TargetMetadata = {
    target: options.target.id,
    version: options.version,
    files,
    updates,
  };
  writeFileSync(
    join(options.outputDirectory, metadataName(options.target.id)),
    `${JSON.stringify(metadata, undefined, 2)}\n`,
  );
  return metadata;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      'bundle-directory': { type: 'string' },
      'output-directory': { type: 'string' },
      target: { type: 'string' },
      version: { type: 'string' },
    },
    strict: true,
  });
  const bundleDirectory = values['bundle-directory'];
  const outputDirectory = values['output-directory'];
  if (
    !bundleDirectory ||
    !outputDirectory ||
    !values.target ||
    !values.version
  ) {
    throw new Error(
      '--bundle-directory, --output-directory, --target and --version are required',
    );
  }
  const metadata = collectArtifacts({
    bundleDirectory,
    outputDirectory,
    target: findTarget(values.target),
    version: values.version,
  });
  process.stdout.write(`${metadata.files.join('\n')}\n`);
}
