import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const executableName = process.platform === 'win32' ? 'klex.exe' : 'klex';
const executablePath = resolve(
  import.meta.dirname,
  '..',
  'dist',
  executableName,
);

if (!existsSync(executablePath)) {
  throw new Error(
    `Klex Agent executable is missing at ${executablePath}; run build:exe first`,
  );
}

// Verify native assets were copied beside the executable.
const distDir = resolve(import.meta.dirname, '..', 'dist');
const nativeAssetChecks: Array<{ name: string; path: string }> = [
  {
    name: 'sharp addon',
    path: resolve(
      distDir,
      'node_modules',
      `@img`,
      `sharp-${process.platform}-${process.arch}`,
      'index.cjs',
    ),
  },
  {
    name: 'sharp libvips',
    path: resolve(
      distDir,
      'node_modules',
      '@img',
      `sharp-libvips-${process.platform}-${process.arch}`,
    ),
  },
  {
    name: 'ffmpeg binary',
    path: resolve(
      distDir,
      'node_modules',
      'ffmpeg-static',
      process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
    ),
  },
  {
    name: 'ffprobe binary',
    path: resolve(
      distDir,
      'node_modules',
      'ffprobe-static',
      'bin',
      process.platform,
      process.arch,
      process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe',
    ),
  },
];

const missingAssets = nativeAssetChecks.filter((check) => {
  if (!existsSync(check.path)) {
    process.stderr.write(
      `Missing native asset: ${check.name} at ${check.path}\n`,
    );
    return true;
  }
  return false;
});

if (missingAssets.length > 0) {
  throw new Error(
    `${missingAssets.length} native asset(s) missing beside executable — ` +
      'run package:exe to copy them, or check copyNativeAssets in package-exe.ts',
  );
}

const result = spawnSync(executablePath, ['--help'], {
  encoding: 'utf8',
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

process.stdout.write(
  `Klex Agent executable smoke test passed: ${executablePath}\n`,
);
