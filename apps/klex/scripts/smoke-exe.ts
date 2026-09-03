import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { resolveApplicationVersion, resolveReleaseTarget } from '@/release';

import { resolveSharpNativePackageNames } from './package-exe';

export function resolveNativeAssetChecks(
  distributionDirectory: string,
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): ReadonlyArray<{ readonly name: string; readonly path: string }> {
  const sharpNativePackages = resolveSharpNativePackageNames(
    platform,
    architecture,
  );
  return [
    {
      name: 'sharp addon',
      path: resolve(
        distributionDirectory,
        'node_modules',
        sharpNativePackages.addon,
        'index.cjs',
      ),
    },
    ...(sharpNativePackages.libvips
      ? [
          {
            name: 'sharp libvips',
            path: resolve(
              distributionDirectory,
              'node_modules',
              sharpNativePackages.libvips,
            ),
          },
        ]
      : []),
    {
      name: 'ffmpeg binary',
      path: resolve(
        distributionDirectory,
        'node_modules',
        'ffmpeg-static',
        platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
      ),
    },
    {
      name: 'ffprobe binary',
      path: resolve(
        distributionDirectory,
        'node_modules',
        '@ffprobe-installer',
        `${platform}-${architecture}`,
        platform === 'win32' ? 'ffprobe.exe' : 'ffprobe',
      ),
    },
    {
      name: 'libsql native addon',
      path: resolve(
        distributionDirectory,
        'node_modules',
        '@libsql',
        resolveReleaseTarget(platform, architecture as NodeJS.Architecture)
          .nativePackageTarget,
        'index.node',
      ),
    },
    {
      name: 'sandbox worker',
      path: resolve(distributionDirectory, 'javascript-sandbox-worker.js'),
    },
    {
      name: 'LiveKit RTC addon',
      path: resolve(distributionDirectory, 'livekit-rtc.node'),
    },
  ];
}

export function smokeKlexDistribution(
  distributionDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  const executableName = process.platform === 'win32' ? 'klex.exe' : 'klex';
  const executablePath = resolve(distributionDirectory, executableName);
  if (!existsSync(executablePath)) {
    throw new Error(
      `Klex Agent executable is missing at ${executablePath}; run build:exe first`,
    );
  }

  const nativeAssetChecks = resolveNativeAssetChecks(distributionDirectory);
  const missingAssets = nativeAssetChecks.filter((check) => {
    if (existsSync(check.path)) return false;
    process.stderr.write(
      `Missing native asset: ${check.name} at ${check.path}\n`,
    );
    return true;
  });
  if (missingAssets.length > 0) {
    throw new Error(
      `${missingAssets.length} native asset(s) missing beside executable`,
    );
  }

  const result = spawnSync(executablePath, ['--help'], {
    encoding: 'utf8',
    env: environment,
    timeout: 30_000,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Klex Agent executable exited with status ${result.status} and signal ${result.signal ?? 'none'}:\n${output}`,
    );
  }
  if (!output.includes('Usage: klex [options]')) {
    throw new Error(`Klex Agent usage banner was not found:\n${output}`);
  }
  const expectedVersion = `Klex Agent v${resolveApplicationVersion(environment)}`;
  if (!output.includes(expectedVersion)) {
    throw new Error(
      `Expected ${expectedVersion} in executable output:\n${output}`,
    );
  }
  // Existence checks above prove the native assets were copied; they cannot
  // prove they load. --verify-native force-loads every native addon inside the
  // real SEA process, which is the only place @rpath resolution, codesigning and
  // createRequire(process.execPath) all interact. sharp and LiveKit are loaded
  // lazily in production, so nothing else in this smoke test touches them.
  const nativeResult = spawnSync(executablePath, ['--verify-native'], {
    encoding: 'utf8',
    env: environment,
    timeout: 60_000,
  });
  const nativeOutput = `${nativeResult.stdout ?? ''}${nativeResult.stderr ?? ''}`;
  if (nativeResult.error) throw nativeResult.error;
  if (nativeResult.status !== 0) {
    throw new Error(
      `Native dependency verification failed with status ${nativeResult.status} and signal ${nativeResult.signal ?? 'none'}:\n${nativeOutput}`,
    );
  }
  process.stdout.write(nativeOutput);

  process.stdout.write(
    `Klex Agent executable smoke test passed: ${executablePath}\n`,
  );
}

function main(): void {
  const { values } = parseArgs({
    options: {
      distribution: { type: 'string' },
    },
    strict: true,
  });
  smokeKlexDistribution(
    resolve(values.distribution ?? resolve(import.meta.dirname, '..', 'dist')),
  );
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) main();
