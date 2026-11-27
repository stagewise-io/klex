// semantic-release plugin for @klex/machine, listed before
// @semantic-release/npm. It checks that the release binaries were built for
// this version, pins the launcher's optionalDependencies to it, and publishes
// the platform packages so those pins resolve once the launcher is published.
//
// KLEX_MACHINE_BINARIES names the directory holding the downloaded
// `klex-machine-<platform>` artifacts, and KLEX_MACHINE_BUILT_VERSION the
// version they were built with.

import { execFile } from 'node:child_process';
import { access, chmod, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import {
  artifactBinary,
  hostPlatform,
  launcherManifest,
  platformPackageName,
  platforms,
  readManifest,
  stagePlatformPackage,
} from './packages.mjs';

const run = promisify(execFile);

function releaseInputs(env) {
  const artifacts = env.KLEX_MACHINE_BINARIES;
  const builtVersion = env.KLEX_MACHINE_BUILT_VERSION;
  if (!artifacts || !builtVersion) {
    throw new Error(
      'KLEX_MACHINE_BINARIES and KLEX_MACHINE_BUILT_VERSION must name the release binaries and the version they were built with.',
    );
  }
  return { artifacts, builtVersion };
}

export function stagingDirectory(root) {
  return join(root, 'dist', 'npm');
}

// semantic-release tags the release before any publish step runs, so a
// platform package npm refuses would leave a tagged release that the next run
// does not retry. Trusted publishing can only be set up for packages that
// already exist, which makes a missing package the likely refusal.
async function unpublishedPlatformPackages(cwd, env) {
  const missing = [];
  for (const platform of platforms) {
    const name = platformPackageName(platform);
    try {
      await run('npm', ['view', name, 'name'], { cwd, env });
    } catch (error) {
      if (!/\bE404\b/.test(error.stderr ?? '')) throw error;
      missing.push(name);
    }
  }
  return missing;
}

export async function verifyConditions(_options, { cwd, env }) {
  const { artifacts } = releaseInputs(env);
  const missing = [];
  for (const platform of platforms) {
    const binary = artifactBinary(artifacts, platform);
    try {
      await access(binary);
      // Workflow artifacts drop the executable bit.
      await chmod(binary, 0o755);
    } catch {
      missing.push(binary);
    }
  }
  if (missing.length > 0) {
    throw new Error(`Missing release binaries: ${missing.join(', ')}`);
  }
  const unpublished = await unpublishedPlatformPackages(cwd, env);
  if (unpublished.length > 0) {
    throw new Error(
      `${unpublished.join(', ')} must exist on npm with trusted publishing set up before @klex/machine can release; see NPM-RELEASES.md.`,
    );
  }
}

export async function verifyRelease(_options, { env, nextRelease }) {
  const { artifacts, builtVersion } = releaseInputs(env);
  if (builtVersion !== nextRelease.version) {
    throw new Error(
      `The release binaries were built as ${builtVersion}, but this release is ${nextRelease.version}.`,
    );
  }
  const host = hostPlatform();
  if (!host) return;
  const { stdout } = await run(artifactBinary(artifacts, host), ['--version']);
  if (stdout.trim() !== nextRelease.version) {
    throw new Error(
      `The ${host.name} release binary reports version ${stdout.trim()}, not ${nextRelease.version}.`,
    );
  }
}

export async function prepare({ pkgRoot }, { cwd, env, logger, nextRelease }) {
  const { artifacts } = releaseInputs(env);
  const root = resolve(cwd, pkgRoot);
  const manifest = await readManifest(root);
  const staging = stagingDirectory(root);
  await rm(staging, { force: true, recursive: true });
  for (const platform of platforms) {
    await stagePlatformPackage({
      binary: artifactBinary(artifacts, platform),
      directory: join(staging, platform.name),
      manifest,
      platform,
      version: nextRelease.version,
    });
  }
  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify(launcherManifest(manifest, nextRelease.version), null, 2)}\n`,
  );
  logger.log(
    'Staged %d platform packages and pinned them at %s',
    platforms.length,
    nextRelease.version,
  );
}

export async function publish({ pkgRoot }, { cwd, env, logger, nextRelease }) {
  const staging = stagingDirectory(resolve(cwd, pkgRoot));
  for (const platform of platforms) {
    const name = platformPackageName(platform);
    logger.log('Publishing %s@%s', name, nextRelease.version);
    await run('npm', ['publish', join(staging, platform.name)], {
      cwd,
      env,
    });
  }
}
