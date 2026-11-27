// The npm packages that ship klex-machine: `@klex/machine`, a thin launcher
// (bin/klex-machine.js), and one package per platform holding the native
// executable. npm installs only the platform package whose `os` and `cpu`
// match, through the launcher's optionalDependencies.
//
// Release binaries are workflow artifacts named `klex-machine-<platform>`.
// Each holds the executable built for `target`.

import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const packageRoot = fileURLToPath(new URL('..', import.meta.url));

export const platforms = [
  {
    name: 'darwin-arm64',
    os: 'darwin',
    cpu: 'arm64',
    target: 'aarch64-apple-darwin',
  },
  {
    name: 'darwin-x64',
    os: 'darwin',
    cpu: 'x64',
    target: 'x86_64-apple-darwin',
  },
  {
    name: 'linux-arm64',
    os: 'linux',
    cpu: 'arm64',
    target: 'aarch64-unknown-linux-musl',
  },
  {
    name: 'linux-x64',
    os: 'linux',
    cpu: 'x64',
    target: 'x86_64-unknown-linux-musl',
  },
  {
    name: 'win32-arm64',
    os: 'win32',
    cpu: 'arm64',
    target: 'aarch64-pc-windows-msvc',
  },
  {
    name: 'win32-x64',
    os: 'win32',
    cpu: 'x64',
    target: 'x86_64-pc-windows-msvc',
  },
];

export function hostPlatform() {
  return platforms.find(
    ({ os, cpu }) => os === process.platform && cpu === process.arch,
  );
}

export function platformPackageName(platform) {
  return `@klex/machine-${platform.name}`;
}

export function executableName(platform) {
  return platform.os === 'win32' ? 'klex-machine.exe' : 'klex-machine';
}

/** Where a downloaded `klex-machine-<platform>` artifact keeps its executable. */
export function artifactBinary(artifactsDirectory, platform) {
  return join(
    artifactsDirectory,
    `klex-machine-${platform.name}`,
    executableName(platform),
  );
}

export async function readManifest(directory = packageRoot) {
  return JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
}

/** The launcher manifest pinned to platform packages of the same version. */
export function launcherManifest(manifest, version, selected = platforms) {
  return {
    ...manifest,
    version,
    optionalDependencies: Object.fromEntries(
      selected.map((platform) => [platformPackageName(platform), version]),
    ),
  };
}

/** Writes one platform package into `directory` and returns its manifest. */
export async function stagePlatformPackage({
  binary,
  directory,
  manifest,
  platform,
  version,
}) {
  const name = platformPackageName(platform);
  const platformManifest = {
    name,
    version,
    description: `The ${platform.name} executable of @klex/machine`,
    license: manifest.license,
    repository: manifest.repository,
    os: [platform.os],
    cpu: [platform.cpu],
    files: ['bin', 'LICENSE', 'README.md'],
    preferUnplugged: true,
    publishConfig: manifest.publishConfig,
  };
  await mkdir(join(directory, 'bin'), { recursive: true });
  const executable = join(directory, 'bin', executableName(platform));
  await copyFile(binary, executable);
  await chmod(executable, 0o755);
  await copyFile(join(packageRoot, 'LICENSE'), join(directory, 'LICENSE'));
  await writeFile(
    join(directory, 'README.md'),
    `# ${name}\n\nThe ${platform.name} executable of [\`@klex/machine\`](https://www.npmjs.com/package/@klex/machine). Install \`@klex/machine\` instead; it selects this package on matching systems.\n`,
  );
  await writeFile(
    join(directory, 'package.json'),
    `${JSON.stringify(platformManifest, null, 2)}\n`,
  );
  return platformManifest;
}
