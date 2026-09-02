import { createHash } from 'node:crypto';
import {
  createReadStream,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import {
  completeReleaseManifestSchema,
  type ReleaseBuildMetadata,
  type ReleaseChannel,
  type ReleaseManifest,
  releaseBuildMetadataSchema,
} from '@/release';

export interface AggregateManifestOptions {
  readonly channel: ReleaseChannel;
  readonly gitCommit: string;
  readonly inputDirectory: string;
  readonly repository: string;
  readonly tag: string;
  readonly version: string;
}

export interface AggregateManifestResult {
  readonly checksumsPath: string;
  readonly manifest: ReleaseManifest;
  readonly manifestChecksumPath: string;
  readonly manifestPath: string;
}

export async function aggregateReleaseManifest(
  options: AggregateManifestOptions,
): Promise<AggregateManifestResult> {
  const inputDirectory = resolve(options.inputDirectory);
  const metadataFiles = readdirSync(inputDirectory)
    .filter(
      (name) => name.startsWith('build-metadata-') && name.endsWith('.json'),
    )
    .sort();
  const builds = metadataFiles.map((name) =>
    releaseBuildMetadataSchema.parse(
      JSON.parse(readFileSync(join(inputDirectory, name), 'utf8')),
    ),
  );
  if (builds.length === 0) throw new Error('No release build metadata found');

  for (const build of builds) assertMatchingIdentity(options, build);
  const tag = encodeURIComponent(options.tag);
  const repository = options.repository.replace(/^\/+|\/+$/g, '');
  const artifacts = await Promise.all(
    builds.map(async (build) => {
      const artifact = build.artifact;
      const archivePath = join(inputDirectory, artifact.archiveFileName);
      const actualSize = statSync(archivePath).size;
      if (actualSize !== artifact.archiveSize) {
        throw new Error(
          `Archive size mismatch for ${artifact.archiveFileName}: expected ${artifact.archiveSize}, got ${actualSize}`,
        );
      }
      const actualHash = await hashFile(archivePath);
      if (actualHash !== artifact.archiveSha256) {
        throw new Error(
          `Archive checksum mismatch for ${artifact.archiveFileName}`,
        );
      }
      return {
        ...artifact,
        url: `https://github.com/${repository}/releases/download/${tag}/${artifact.archiveFileName}`,
      };
    }),
  );
  const manifest = completeReleaseManifestSchema.parse({
    artifacts,
    channel: options.channel,
    gitCommit: options.gitCommit,
    schemaVersion: 1,
    version: options.version,
  });
  const manifestPath = join(inputDirectory, 'release-manifest.json');
  const checksumsPath = join(inputDirectory, 'checksums.txt');
  const manifestChecksumPath = `${manifestPath}.sha256`;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`);
  const manifestSha256 = await hashFile(manifestPath);
  const checksumLines = [...manifest.artifacts]
    .sort((left, right) =>
      left.archiveFileName.localeCompare(right.archiveFileName),
    )
    .map(
      (artifact) => `${artifact.archiveSha256}  ${artifact.archiveFileName}`,
    );
  checksumLines.push(`${manifestSha256}  ${basename(manifestPath)}`);
  writeFileSync(checksumsPath, `${checksumLines.join('\n')}\n`);
  writeFileSync(
    manifestChecksumPath,
    `${manifestSha256}  ${basename(manifestPath)}\n`,
  );
  return { checksumsPath, manifest, manifestChecksumPath, manifestPath };
}

function assertMatchingIdentity(
  options: AggregateManifestOptions,
  build: ReleaseBuildMetadata,
): void {
  for (const key of ['channel', 'gitCommit', 'version'] as const) {
    if (build[key] !== options[key]) {
      throw new Error(
        `Release identity mismatch in ${build.artifact.archiveFileName}: ${key}`,
      );
    }
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv
      .slice(2)
      .filter((argument, index) => index > 0 || argument !== '--'),
    options: {
      channel: { type: 'string' },
      'git-commit': { type: 'string' },
      'input-directory': { type: 'string', default: '.' },
      repository: { type: 'string' },
      tag: { type: 'string' },
      version: { type: 'string' },
    },
    strict: true,
  });
  if (
    !values.version ||
    !values.channel ||
    !values.tag ||
    !values['git-commit'] ||
    !values.repository
  ) {
    throw new Error(
      '--version, --channel, --tag, --git-commit, and --repository are required',
    );
  }
  if (values.channel !== 'stable' && values.channel !== 'nightly') {
    throw new Error(`Invalid release channel: ${values.channel}`);
  }
  const result = await aggregateReleaseManifest({
    channel: values.channel,
    gitCommit: values['git-commit'],
    inputDirectory: values['input-directory'],
    repository: values.repository,
    tag: values.tag,
    version: values.version,
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        checksums: basename(result.checksumsPath),
        manifest: basename(result.manifestPath),
        manifestChecksum: basename(result.manifestChecksumPath),
      },
      undefined,
      2,
    )}\n`,
  );
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  await main();
}
