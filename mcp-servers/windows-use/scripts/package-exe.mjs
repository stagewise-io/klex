import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const postjectCli = require.resolve('postject/dist/cli.js');
const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist');
const main = join(dist, 'main.js');
const blob = join(dist, 'sea-prep.blob');
const signingScript = join(root, 'packaging', 'sign-windows-executable.ps1');
const signTool = process.env.SIGNTOOL_PATH;
const signingRequired = /^(1|true|yes)$/i.test(
  process.env.WINDOWS_SIGNING_REQUIRED ?? '',
);
const executable = join(
  dist,
  process.platform === 'win32'
    ? 'stagewise-windows-use.exe'
    : 'stagewise-windows-use',
);

if (!existsSync(main)) {
  throw new Error('dist/main.js not found; build the SEA bundle first');
}
mkdirSync(dist, { recursive: true });
run(process.execPath, ['--experimental-sea-config', 'sea-config.json']);
if (!existsSync(blob)) throw new Error('Node SEA blob was not generated');
copyFileSync(process.execPath, executable);
chmodSync(executable, 0o755);
if (process.platform === 'darwin') {
  run('codesign', ['--remove-signature', executable]);
} else if (process.platform === 'win32') {
  // Postject must mutate the PE before our final Authenticode signature is applied.
  if (!signTool) {
    if (signingRequired) {
      throw new Error(
        'SIGNTOOL_PATH is required for signed Windows SEA builds',
      );
    }
  } else {
    if (!existsSync(signTool)) {
      throw new Error(`SIGNTOOL_PATH does not exist: ${signTool}`);
    }
    run(signTool, ['remove', '/s', executable]);
  }
}
run(process.execPath, [
  postjectCli,
  executable,
  'NODE_SEA_BLOB',
  blob,
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ...(process.platform === 'darwin'
    ? ['--macho-segment-name', 'NODE_SEA']
    : []),
]);
if (process.platform === 'darwin') {
  run('codesign', ['--force', '--sign', '-', executable]);
} else if (process.platform === 'win32') {
  run('pwsh', [
    '-NoProfile',
    '-NonInteractive',
    '-File',
    signingScript,
    '-ExecutablePath',
    executable,
  ]);
}

console.log(`Standalone executable: ${executable}`);

function run(command, args) {
  console.log(`$ ${command} ${args.join(' ')}`);
  execFileSync(command, args, { cwd: root, stdio: 'inherit' });
}
