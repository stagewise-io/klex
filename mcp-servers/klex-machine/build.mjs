// Builds klex-machine with Cargo and copies the executable to dist/, where
// bin/klex-machine.js finds it in a monorepo checkout. Only dist/ is a turbo
// output; target/ is far too large for the cache.
//
// KLEX_MACHINE_BUILD_PROFILE selects the Cargo profile (default: release).
// KLEX_MACHINE_BUILD_TARGET selects a target triple (default: the host).

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('.', import.meta.url));
const profile = process.env.KLEX_MACHINE_BUILD_PROFILE || 'release';
const target = process.env.KLEX_MACHINE_BUILD_TARGET || '';

const cargoArgs = [
  'build',
  '--locked',
  '--package',
  'klex-machine',
  '--bin',
  'klex-machine',
  '--profile',
  profile,
  ...(target ? ['--target', target] : []),
];
execFileSync('cargo', cargoArgs, { cwd: packageRoot, stdio: 'inherit' });

const metadata = JSON.parse(
  execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], {
    cwd: packageRoot,
    encoding: 'utf8',
  }),
);
const windows = target
  ? target.includes('windows')
  : process.platform === 'win32';
const executable = `klex-machine${windows ? '.exe' : ''}`;
const source = join(
  metadata.target_directory,
  ...(target ? [target] : []),
  profile === 'dev' ? 'debug' : profile,
  executable,
);

const dist = join(packageRoot, 'dist');
rmSync(dist, { force: true, recursive: true });
mkdirSync(dist, { recursive: true });
copyFileSync(source, join(dist, executable));
console.log(`Copied ${executable} to ${dist}`);
