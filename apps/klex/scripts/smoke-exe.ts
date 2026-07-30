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
