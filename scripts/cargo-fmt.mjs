// Runs `cargo fmt --all` from the repository root; pass --check to verify.
// Contributors without a Rust toolchain get a notice instead of a failure,
// except in CI, where a missing toolchain must not hide unformatted code.

import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const check = process.argv.includes('--check');

const result = spawnSync(
  'cargo',
  ['fmt', '--all', ...(check ? ['--', '--check'] : [])],
  { cwd: repositoryRoot, stdio: 'inherit' },
);

if (result.error?.code === 'ENOENT') {
  const message =
    'cargo was not found; skipping Rust formatting. Install rustup to format the Rust crates.';
  if (process.env.CI) {
    console.error(message);
    process.exit(1);
  }
  console.warn(message);
  process.exit(0);
}
if (result.error) throw result.error;
process.exit(result.status ?? 1);
