import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  createReadStream,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import {
  notarizeMacOSArchive,
  type PackagedAppArtifact,
  signExecutables,
} from '@stagewise/app-packager';

import {
  getReleaseArtifactName,
  type ReleaseBuildMetadata,
  type ReleaseChannel,
  releaseBuildMetadataSchema,
  resolveApplicationVersion,
  resolveReleaseChannel,
  resolveReleaseTarget,
} from '@/release';

import { listPackagedCodeFiles, packageKlexAgent } from '../package-exe';
import { smokeKlexDistribution } from '../smoke-exe';

const KLEX_ROOT = resolve(import.meta.dirname, '..', '..');

export interface BuildReleaseArtifactOptions {
  readonly channel: ReleaseChannel;
  readonly environment?: NodeJS.ProcessEnv;
  readonly gitCommit: string;
  readonly outputDirectory: string;
  readonly tag: string;
  readonly version: string;
}

export interface BuildReleaseArtifactResult {
  readonly archivePath: string;
  readonly metadata: ReleaseBuildMetadata;
  readonly metadataPath: string;
}

export interface BuildReleaseArtifactDependencies {
  readonly archive?: (
    directory: string,
    archivePath: string,
    platform: NodeJS.Platform,
  ) => void;
  readonly isMachO?: (file: string) => boolean;
  readonly notarize?: typeof notarizeMacOSArchive;
  readonly packageAgent?: typeof packageKlexAgent;
  readonly resolveTarget?: typeof resolveReleaseTarget;
  readonly run?: typeof runCommand;
  readonly signMany?: typeof signExecutables;
  readonly smoke?: typeof smokeKlexDistribution;
}

export async function buildReleaseArtifact(
  options: BuildReleaseArtifactOptions,
  dependencies: BuildReleaseArtifactDependencies = {},
): Promise<BuildReleaseArtifactResult> {
  const environment = options.environment ?? process.env;
  const releaseEnvironment = {
    ...environment,
    KLEX_RELEASE_CHANNEL: options.channel,
    KLEX_RELEASE_TAG: options.tag,
    KLEX_VERSION: options.version,
  };
  const resolvedVersion = resolveApplicationVersion({
    ...releaseEnvironment,
  });
  if (resolveReleaseChannel(resolvedVersion) !== options.channel) {
    throw new Error('Release channel does not match the requested version');
  }

  const definition = (dependencies.resolveTarget ?? resolveReleaseTarget)();
  const artifact = await (dependencies.packageAgent ?? packageKlexAgent)(
    [],
    releaseEnvironment,
  );
  assertPackagedHost(artifact, definition.platform, definition.architecture);

  const outputDirectory = resolve(options.outputDirectory);
  const stageName = `klex-${options.version}-${definition.target}`;
  const stageDirectory = join(outputDirectory, 'stage', stageName);
  rmSync(stageDirectory, { force: true, recursive: true });
  mkdirSync(stageDirectory, { recursive: true });
  stageDistribution(
    dirname(artifact.outputPath),
    stageDirectory,
    definition.platform,
    artifact.assets,
  );

  let signed = false;
  let verified = false;
  let notarized = false;
  let signingProvider: string | undefined;
  if (definition.platform === 'darwin') {
    const candidates = listPackagedCodeFiles(
      stageDirectory,
      definition.platform,
    );
    const isMachO = dependencies.isMachO ?? isMachOFile;
    const files = candidates.filter(isMachO);
    const result = await (dependencies.signMany ?? signExecutables)({
      environment: releaseEnvironment,
      files,
      macos: { identity: environment.APPLE_SIGNING_IDENTITY },
      mode: 'required',
      platform: 'darwin',
    });
    ({ signed, verified, provider: signingProvider } = result);

    const notarizationDirectory = mkdtempSync(
      join(tmpdir(), 'klex-notarization-'),
    );
    try {
      const submission = join(notarizationDirectory, 'klex.zip');
      (dependencies.run ?? runCommand)('ditto', [
        '-c',
        '-k',
        '--keepParent',
        stageDirectory,
        submission,
      ]);
      (dependencies.notarize ?? notarizeMacOSArchive)({
        environment: releaseEnvironment,
        file: submission,
      });
      notarized = true;
    } finally {
      rmSync(notarizationDirectory, { force: true, recursive: true });
    }
  } else if (definition.platform === 'win32') {
    const files = listPackagedCodeFiles(
      stageDirectory,
      definition.platform,
    ).filter((file) => /\.(?:dll|exe|node)$/i.test(file));
    const result = await (dependencies.signMany ?? signExecutables)({
      environment: releaseEnvironment,
      files,
      mode: 'required',
      platform: 'win32',
    });
    ({ signed, verified, provider: signingProvider } = result);
  }

  (dependencies.smoke ?? smokeKlexDistribution)(
    stageDirectory,
    releaseEnvironment,
  );

  mkdirSync(outputDirectory, { recursive: true });
  const archiveFileName = getReleaseArtifactName(
    options.version,
    definition.target,
  );
  const archivePath = join(outputDirectory, archiveFileName);
  rmSync(archivePath, { force: true });
  (dependencies.archive ?? createArchive)(
    stageDirectory,
    archivePath,
    definition.platform,
  );
  const archiveSha256 = await hashFile(archivePath);
  const metadata = releaseBuildMetadataSchema.parse({
    artifact: {
      archiveFileName,
      archiveSha256,
      archiveSize: statSync(archivePath).size,
      nodeVersion: artifact.nodeVersion,
      notarized,
      signed,
      ...(signingProvider ? { signingProvider } : {}),
      target: definition.target,
      verified,
    },
    channel: options.channel,
    gitCommit: options.gitCommit,
    schemaVersion: 1,
    version: options.version,
  });
  const metadataPath = join(
    outputDirectory,
    `build-metadata-${definition.target}.json`,
  );
  writeFileSync(metadataPath, `${JSON.stringify(metadata, undefined, 2)}\n`);
  return { archivePath, metadata, metadataPath };
}

function stageDistribution(
  packageDirectory: string,
  stageDirectory: string,
  platform: NodeJS.Platform,
  assets: readonly string[],
): void {
  const executableName = platform === 'win32' ? 'klex.exe' : 'klex';
  for (const name of new Set([
    executableName,
    'javascript-sandbox-worker.js',
    'livekit-rtc.node',
    'node_modules',
    ...assets,
  ])) {
    cpSync(join(packageDirectory, name), join(stageDirectory, name), {
      recursive: true,
    });
  }
}

function assertPackagedHost(
  artifact: PackagedAppArtifact,
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
): void {
  if (
    artifact.platform !== platform ||
    artifact.architecture !== architecture
  ) {
    throw new Error(
      `Packaged host ${artifact.platform}-${artifact.architecture} does not match ${platform}-${architecture}`,
    );
  }
}

function isMachOFile(file: string): boolean {
  return runCommand('file', ['--brief', file]).includes('Mach-O');
}

function createArchive(
  directory: string,
  archivePath: string,
  platform: NodeJS.Platform,
): void {
  if (platform === 'win32') {
    runCommand('powershell', [
      '-NoProfile',
      '-Command',
      'Compress-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force',
      directory,
      archivePath,
    ]);
    return;
  }
  runCommand('tar', [
    '-czf',
    archivePath,
    '-C',
    dirname(directory),
    basename(directory),
  ]);
}

function runCommand(command: string, arguments_: readonly string[]): string {
  const result = spawnSync(command, [...arguments_], {
    encoding: 'utf8',
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} failed with status ${result.status}: ${result.stderr ?? ''}`,
    );
  }
  return result.stdout ?? '';
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
      'output-directory': { type: 'string', default: 'dist/release' },
      tag: { type: 'string' },
      version: { type: 'string' },
    },
    strict: true,
  });
  if (
    !values.version ||
    !values.channel ||
    !values.tag ||
    !values['git-commit']
  ) {
    throw new Error(
      '--version, --channel, --tag, and --git-commit are required',
    );
  }
  if (values.channel !== 'stable' && values.channel !== 'nightly') {
    throw new Error(`Invalid release channel: ${values.channel}`);
  }
  const result = await buildReleaseArtifact({
    channel: values.channel,
    gitCommit: values['git-commit'],
    outputDirectory: resolve(KLEX_ROOT, values['output-directory']),
    tag: values.tag,
    version: values.version,
  });
  process.stdout.write(`${JSON.stringify(result, undefined, 2)}\n`);
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  await main();
}
