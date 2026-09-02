import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import {
  type AppPackagerConfig,
  type PackagedAppArtifact,
  packageApp,
} from '@stagewise/app-packager';

import { resolveApplicationVersion, resolveReleaseTarget } from '@/release';

const ROOT = resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);

export function resolveLiveKitNativeAddon(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): string {
  const { nativePackageTarget } = resolveReleaseTarget(
    platform,
    architecture as NodeJS.Architecture,
  );
  const liveKitRequire = createRequire(require.resolve('@livekit/rtc-node'));
  const bindingsRequire = createRequire(
    liveKitRequire.resolve('@livekit/rtc-ffi-bindings'),
  );
  return bindingsRequire.resolve(
    `@livekit/rtc-ffi-bindings-${nativePackageTarget}`,
  );
}

export function resolveFfprobeInstallerPackageName(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): string {
  resolveReleaseTarget(platform, architecture as NodeJS.Architecture);
  return `@ffprobe-installer/${platform}-${architecture}`;
}

export function resolveFfprobeInstaller(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): { readonly binaryPath: string; readonly packageName: string } {
  const packageName = resolveFfprobeInstallerPackageName(
    platform,
    architecture,
  );
  const binary = platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
  const ffprobeRequire = createRequire(
    require.resolve('@ffprobe-installer/ffprobe'),
  );
  return {
    binaryPath: ffprobeRequire.resolve(`${packageName}/${binary}`),
    packageName,
  };
}

export interface KlexAgentPackagingOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly skipNotarize?: boolean;
}

export function createKlexAgentPackagerConfig(
  options: KlexAgentPackagingOptions = {},
): AppPackagerConfig {
  const environment = options.environment ?? process.env;
  const identity = environment.APPLE_SIGNING_IDENTITY?.trim();
  const platform = options.platform ?? process.platform;
  const releaseBuild = environment.KLEX_RELEASE_CHANNEL !== undefined;
  if (releaseBuild && options.skipNotarize) {
    throw new Error('--skip-notarize is not allowed for release builds');
  }
  const requiresExecutableSigning =
    releaseBuild && (platform === 'darwin' || platform === 'win32');

  return {
    name: 'klex',
    entry: 'dist/main.js',
    outputDirectory: 'dist',
    assets: {
      'javascript-sandbox-worker.js': 'dist/javascript-sandbox-worker.js',
      'livekit-rtc.node': resolveLiveKitNativeAddon(),
    },
    useCodeCache: true,
    signing: { mode: requiresExecutableSigning ? 'required' : 'optional' },
    macos: {
      ...(identity ? { identity } : {}),
      entitlements: {
        allowJit: true,
        allowUnsignedExecutableMemory: true,
        disableLibraryValidation: true,
      },
    },
  };
}

/**
 * Copies native packages beside the SEA executable.
 *
 * The SEA build virtualizes native-backed packages via
 * nativeShimPlugin (build.ts) so they load from on-disk node_modules/ using
 * createRequire(process.execPath). This function copies all required packages:
 *
 * 1. **sharp** (JS) + deps (detect-libc, semver, @img/colour) — sharp's CJS
 *    entry does `require('@img/sharp-…/sharp.node')` at runtime which resolves
 *    from the on-disk node_modules. The .node addon's @rpath links to the
 *    sibling @img/sharp-libvips-…/lib directory for the libvips dylib.
 *
 * 2. **ffmpeg-static** — prebuilt ffmpeg binary. The package's index.js uses
 *    `__dirname` to locate the binary, which works because the package is
 *    loaded from disk via createRequire (not bundled into the SEA blob).
 *
 * 3. **@ffprobe-installer/ffprobe** + its platform payload — the wrapper
 *    resolves the sibling platform package and its prebuilt ffprobe binary.
 *
 * 4. **libsql** + its platform addon — loaded from disk so libsql's dynamic
 *    `require('@libsql/<target>')` resolves through a normal Node require.
 *
 * All packages are **mandatory** — if any cannot be found or copied, the
 * build fails. There is no graceful degradation; native media processing
 * (audio transcoding, image resizing, vision fallback) is required at runtime.
 */
export function copyNativeAssets(outputDirectory: string): void {
  const require = createRequire(import.meta.url);
  const destNodeModules = join(outputDirectory, 'node_modules');
  mkdirSync(destNodeModules, { recursive: true });

  const errors: string[] = [];

  /** Resolves a package's root directory from its package.json. */
  function resolvePackageDir(
    name: string,
    packageRequire: NodeJS.Require = require,
  ): string {
    // Try resolving the main entry first; fall back to package.json
    // (some @img packages only export ./sharp.node and ./package).
    let resolveTarget: string;
    try {
      packageRequire.resolve(name);
      resolveTarget = name;
    } catch {
      resolveTarget = `${name}/package`;
    }
    const resolvedPath = packageRequire.resolve(resolveTarget);
    // If we resolved package.json, the dir is its parent.
    // If we resolved the main entry, walk up to find package.json.
    let dir = dirname(resolvedPath);
    for (;;) {
      if (existsSync(join(dir, 'package.json'))) return dir;
      const parent = dirname(dir);
      if (parent === dir) {
        throw new Error(
          `Could not find package.json for ${name} starting from ${resolvedPath}`,
        );
      }
      dir = parent;
    }
  }

  /** Copies a package to dest/node_modules/<name>. */
  function copyPackage(
    name: string,
    packageRequire: NodeJS.Require = require,
  ): boolean {
    try {
      const pkgDir = resolvePackageDir(name, packageRequire);
      cpSync(pkgDir, join(destNodeModules, name), { recursive: true });
      return true;
    } catch (e) {
      errors.push(`Failed to copy ${name}: ${(e as Error).message}`);
      return false;
    }
  }

  const platformArch = `${process.platform}-${process.arch}`;
  const { nativePackageTarget } = resolveReleaseTarget();

  // sharp JS package + runtime dependencies (all loaded from disk at runtime)
  const sharpRequire = createRequire(require.resolve('sharp'));
  copyPackage('sharp');
  copyPackage('detect-libc', sharpRequire);
  copyPackage('semver', sharpRequire);
  copyPackage('@img/colour', sharpRequire);

  // sharp native addons (platform-specific .node addon + libvips dylib)
  copyPackage(`@img/sharp-${platformArch}`, sharpRequire);
  copyPackage(`@img/sharp-libvips-${platformArch}`, sharpRequire);

  // audio and realtime-media native payloads
  copyPackage('ffmpeg-static');
  copyPackage('@ffprobe-installer/ffprobe');
  try {
    const ffprobe = resolveFfprobeInstaller();
    cpSync(
      dirname(ffprobe.binaryPath),
      join(destNodeModules, ffprobe.packageName),
      { recursive: true },
    );
  } catch (error) {
    errors.push(
      `Failed to copy ffprobe platform package: ${(error as Error).message}`,
    );
  }
  try {
    cpSync(
      resolveLiveKitNativeAddon(),
      join(outputDirectory, 'livekit-rtc.node'),
    );
  } catch (error) {
    errors.push(
      `Failed to copy LiveKit RTC addon: ${(error as Error).message}`,
    );
  }

  // SQLite native addon and its runtime target loader
  const libsqlClientRequire = createRequire(require.resolve('@libsql/client'));
  const libsqlRequire = createRequire(libsqlClientRequire.resolve('libsql'));
  copyPackage('libsql', libsqlClientRequire);
  copyPackage('@neon-rs/load', libsqlRequire);
  copyPackage(`@libsql/${nativePackageTarget}`, libsqlRequire);

  // Verify critical files exist after copy
  const checks: Array<{ name: string; path: string }> = [
    {
      name: 'sharp package',
      path: join(destNodeModules, 'sharp', 'package.json'),
    },
    {
      name: 'sharp native addon',
      path: join(destNodeModules, '@img', `sharp-${platformArch}`, 'index.cjs'),
    },
    {
      name: 'sharp libvips',
      path: join(destNodeModules, '@img', `sharp-libvips-${platformArch}`),
    },
    {
      name: 'ffmpeg binary',
      path: join(
        destNodeModules,
        'ffmpeg-static',
        process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
      ),
    },
    {
      name: 'libsql native addon',
      path: join(destNodeModules, '@libsql', nativePackageTarget, 'index.node'),
    },
    {
      name: 'ffprobe binary',
      path: join(
        destNodeModules,
        '@ffprobe-installer',
        `${process.platform}-${process.arch}`,
        process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe',
      ),
    },
    {
      name: 'LiveKit RTC addon',
      path: join(outputDirectory, 'livekit-rtc.node'),
    },
  ];

  for (const check of checks) {
    if (!existsSync(check.path)) {
      errors.push(`${check.name} not found at ${check.path}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Native asset packaging failed — media processing will not work at runtime:\n  - ${errors.join('\n  - ')}`,
    );
  }
}

export function listPackagedCodeFiles(
  outputDirectory: string,
  platform: NodeJS.Platform = process.platform,
): readonly string[] {
  const executableName = platform === 'win32' ? 'klex.exe' : 'klex';
  const executablePath = join(outputDirectory, executableName);
  const files: string[] = [];

  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile()) {
        const executable = (statSync(path).mode & 0o111) !== 0;
        const nativeExtension = /\.(?:dylib|dll|exe|node)$/i.test(entry.name);
        if (path === executablePath || nativeExtension || executable)
          files.push(path);
      }
    }
  }

  visit(outputDirectory);
  return files.sort((left, right) => {
    if (left === executablePath) return 1;
    if (right === executablePath) return -1;
    return left.localeCompare(right);
  });
}

export async function packageKlexAgent(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<PackagedAppArtifact> {
  const normalizedArguments = arguments_.filter(
    (argument) => argument !== '--',
  );
  const { values } = parseArgs({
    args: normalizedArguments,
    options: {
      'skip-notarize': { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  resolveApplicationVersion(environment);
  const config = createKlexAgentPackagerConfig({
    environment,
    skipNotarize: values['skip-notarize'],
  });
  const artifact = await packageApp(config, {
    baseDirectory: ROOT,
    environment,
  });
  copyNativeAssets(dirname(artifact.outputPath));
  return artifact;
}

async function main(): Promise<void> {
  const artifact = await packageKlexAgent(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(artifact, undefined, 2)}\n`);
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  await main();
}
