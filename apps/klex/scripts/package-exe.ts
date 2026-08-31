import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import {
  type AppPackagerConfig,
  type PackagedAppArtifact,
  packageApp,
} from '@stagewise/app-packager';

const ROOT = resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const LIVEKIT_BINDING_PACKAGES: Partial<
  Record<NodeJS.Platform, Partial<Record<string, string>>>
> = {
  darwin: {
    arm64: '@livekit/rtc-ffi-bindings-darwin-arm64',
    x64: '@livekit/rtc-ffi-bindings-darwin-x64',
  },
  linux: {
    arm64: '@livekit/rtc-ffi-bindings-linux-arm64-gnu',
    x64: '@livekit/rtc-ffi-bindings-linux-x64-gnu',
  },
  win32: {
    x64: '@livekit/rtc-ffi-bindings-win32-x64-msvc',
  },
};

export function resolveLiveKitNativeAddon(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): string {
  const packageName = LIVEKIT_BINDING_PACKAGES[platform]?.[architecture];
  if (!packageName)
    throw new Error(
      `LiveKit does not support executable packaging for ${platform}-${architecture}`,
    );
  return require.resolve(packageName);
}

export interface KlexAgentPackagingOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly skipNotarize?: boolean;
}

export function createKlexAgentPackagerConfig(
  options: KlexAgentPackagingOptions = {},
): AppPackagerConfig {
  const environment = options.environment ?? process.env;
  const identity = environment.APPLE_SIGNING_IDENTITY?.trim();
  const shouldNotarize =
    !options.skipNotarize &&
    Boolean(
      environment.APPLE_ID &&
        environment.APPLE_PASSWORD &&
        environment.APPLE_TEAM_ID,
    );

  return {
    name: 'klex',
    entry: 'dist/main.js',
    outputDirectory: 'dist',
    assets: {
      'javascript-sandbox-worker.js': 'dist/javascript-sandbox-worker.js',
      'livekit-rtc.node': resolveLiveKitNativeAddon(),
    },
    useCodeCache: true,
    signing: { mode: 'optional' },
    macos: {
      ...(identity ? { identity } : {}),
      entitlements: {
        allowJit: true,
        allowUnsignedExecutableMemory: true,
        disableLibraryValidation: true,
      },
      ...(shouldNotarize
        ? { notarization: { enabled: true, staple: true } as const }
        : {}),
    },
  };
}

/**
 * Copies native packages beside the SEA executable.
 *
 * The SEA build virtualizes sharp, ffmpeg-static, and ffprobe-static via
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
 * 3. **ffprobe-static** — same pattern as ffmpeg-static.
 *
 * All packages are **mandatory** — if any cannot be found or copied, the
 * build fails. There is no graceful degradation; native media processing
 * (audio transcoding, image resizing, vision fallback) is required at runtime.
 */
function copyNativeAssets(outputDirectory: string): void {
  const require = createRequire(import.meta.url);
  const destNodeModules = join(outputDirectory, 'node_modules');
  mkdirSync(destNodeModules, { recursive: true });

  const errors: string[] = [];

  /** Resolves a package's root directory from its package.json. */
  function resolvePackageDir(name: string): string {
    // Try resolving the main entry first; fall back to package.json
    // (some @img packages only export ./sharp.node and ./package).
    let resolveTarget: string;
    try {
      require.resolve(name);
      resolveTarget = name;
    } catch {
      resolveTarget = `${name}/package`;
    }
    const resolvedPath = require.resolve(resolveTarget);
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
  function copyPackage(name: string): boolean {
    try {
      const pkgDir = resolvePackageDir(name);
      cpSync(pkgDir, join(destNodeModules, name), { recursive: true });
      return true;
    } catch (e) {
      errors.push(`Failed to copy ${name}: ${(e as Error).message}`);
      return false;
    }
  }

  const platformArch = `${process.platform}-${process.arch}`;

  // sharp JS package + runtime dependencies (all loaded from disk at runtime)
  copyPackage('sharp');
  copyPackage('detect-libc');
  copyPackage('semver');
  copyPackage('@img/colour');

  // sharp native addons (platform-specific .node addon + libvips dylib)
  copyPackage(`@img/sharp-${platformArch}`);
  copyPackage(`@img/sharp-libvips-${platformArch}`);

  // audio processing binaries
  copyPackage('ffmpeg-static');
  copyPackage('ffprobe-static');

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
      name: 'ffprobe binary',
      path: join(
        destNodeModules,
        'ffprobe-static',
        'bin',
        process.platform,
        process.arch,
        process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe',
      ),
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
