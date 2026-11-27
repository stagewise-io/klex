#!/usr/bin/env node
// Runs the native klex-machine executable from the platform package npm
// installed through optionalDependencies, forwarding arguments, stdio,
// signals and the exit status.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const supported = [
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-arm64',
  'win32-x64',
];
const platform = `${process.platform}-${process.arch}`;
const executable =
  process.platform === 'win32' ? 'klex-machine.exe' : 'klex-machine';

function binaryPath() {
  if (process.env.KLEX_MACHINE_BINARY_PATH) {
    return process.env.KLEX_MACHINE_BINARY_PATH;
  }
  const platformPackage = `@klex/machine-${platform}`;
  try {
    const manifest = createRequire(import.meta.url).resolve(
      `${platformPackage}/package.json`,
    );
    return join(dirname(manifest), 'bin', executable);
  } catch {}
  // `pnpm --filter @klex/machine build` leaves a host build here.
  const local = fileURLToPath(
    new URL(`../dist/${executable}`, import.meta.url),
  );
  if (existsSync(local)) return local;
  if (!supported.includes(platform)) {
    throw new Error(
      `@klex/machine has no executable for ${platform}. Supported platforms: ${supported.join(', ')}.`,
    );
  }
  throw new Error(
    `${platformPackage} is not installed. Reinstall @klex/machine without --no-optional or --omit=optional so your package manager installs it.`,
  );
}

let binary;
try {
  binary = binaryPath();
} catch (error) {
  process.stderr.write(`klex-machine: ${error.message}\n`);
  process.exit(1);
}

const child = spawn(binary, process.argv.slice(2), { stdio: 'inherit' });

// Windows sends Ctrl+C and console close to every process on the console,
// and kill() there terminates instead of signalling, so the launcher only
// waits. Elsewhere a signal sent to the launcher alone must reach the
// executable; one that also reaches it directly, like Ctrl+C in a terminal,
// arrives twice, and the executable ignores a quick repeat.
const signals =
  process.platform === 'win32'
    ? ['SIGINT', 'SIGBREAK', 'SIGHUP']
    : ['SIGINT', 'SIGTERM', 'SIGHUP'];
const forward = (signal) => {
  if (process.platform !== 'win32') child.kill(signal);
};
for (const signal of signals) process.on(signal, forward);

child.on('error', (error) => {
  process.stderr.write(
    `klex-machine: cannot run ${binary}: ${error.message}\n`,
  );
  process.exit(1);
});
child.on('exit', (code, signal) => {
  for (const name of signals) process.off(name, forward);
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
