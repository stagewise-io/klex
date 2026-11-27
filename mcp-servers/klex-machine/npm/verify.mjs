// Packs @klex/machine and this host's platform package around an executable,
// installs both tarballs into a scratch project with npm, and runs the
// installed command: --version, then a local-mode server that must answer
// /health and shut down gracefully on signals sent the ways supervisors and
// terminals send them. Nothing is published.
//
//   node npm/verify.mjs [--binary <path>]   (default: dist/klex-machine)

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';

import {
  executableName,
  hostPlatform,
  launcherManifest,
  packageRoot,
  platformPackageName,
  platforms,
  readManifest,
  stagePlatformPackage,
} from './packages.mjs';

const windows = process.platform === 'win32';
const host = hostPlatform();
if (!host)
  throw new Error(
    `No platform package for ${process.platform}-${process.arch}`,
  );

const { values } = parseArgs({ options: { binary: { type: 'string' } } });
const binary = resolve(
  values.binary ?? join(packageRoot, 'dist', executableName(host)),
);
if (!existsSync(binary)) throw new Error(`Missing executable: ${binary}`);

// npm runs through Node rather than its Windows `.cmd` shim, whose argument
// parsing goes through cmd.exe.
const npmCli = windows
  ? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  : join(
      dirname(process.execPath),
      '..',
      'lib',
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js',
    );
if (!existsSync(npmCli)) throw new Error(`Missing npm CLI: ${npmCli}`);

function run(command, args, options = {}) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'inherit'],
      ...options,
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.once('error', fail);
    child.once('exit', (code) =>
      code === 0
        ? done(stdout)
        : fail(new Error(`${command} ${args.join(' ')} exited with ${code}`)),
    );
  });
}

function npm(args, options) {
  return run(process.execPath, [npmCli, ...args], options);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function pack(directory, destination) {
  const [result] = JSON.parse(
    await npm(['pack', '--json', '--pack-destination', destination], {
      cwd: directory,
    }),
  );
  return { path: join(destination, result.filename), files: result.files };
}

/** Starts the installed launcher in local mode and waits for its port. */
async function startServer(launcher, dataDir, detached) {
  const child = spawn(
    process.execPath,
    [
      launcher,
      'serve',
      '--mode',
      'local',
      '--port',
      '0',
      '--data-dir',
      dataDir,
      '--cwd',
      dataDir,
    ],
    {
      detached,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  const exited = new Promise((done) =>
    child.once('exit', (code, signal) => done({ code, signal })),
  );
  const port = await new Promise((done, fail) => {
    const lines = createInterface({ input: child.stderr });
    lines.on('line', (line) => {
      try {
        const record = JSON.parse(line);
        if (record.message === 'klex-machine MCP server listening')
          done(record.port);
      } catch {}
    });
    exited.then(({ code }) => fail(new Error(`server exited early: ${code}`)));
  });
  return { child, exited, port };
}

async function within(promise, milliseconds, message) {
  let timer;
  const timeout = new Promise((_, fail) => {
    timer = setTimeout(() => fail(new Error(message)), milliseconds);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const scratch = await mkdtemp(join(tmpdir(), 'klex-machine-verify-'));
try {
  const version = '0.0.0-verify';
  const manifest = await readManifest();

  const { files: launcherFiles } = JSON.parse(
    await npm(['pack', '--dry-run', '--json'], { cwd: packageRoot }),
  )[0];
  const published = launcherFiles.map(({ path }) => path).sort();
  assert(
    JSON.stringify(published) ===
      JSON.stringify([
        'LICENSE',
        'README.md',
        'bin/klex-machine.js',
        'package.json',
      ]),
    `Unexpected @klex/machine files: ${published.join(', ')}`,
  );

  const launcherDirectory = join(scratch, 'launcher');
  await mkdir(launcherDirectory);
  for (const file of ['bin', 'LICENSE', 'README.md']) {
    await cp(join(packageRoot, file), join(launcherDirectory, file), {
      recursive: true,
    });
  }
  const pinned = launcherManifest(manifest, version);
  assert(
    Object.keys(pinned.optionalDependencies).length === platforms.length &&
      Object.values(pinned.optionalDependencies).every(
        (pin) => pin === version,
      ),
    'The launcher must pin every platform package at its own version',
  );
  // Only this host's package exists outside a registry, so the installed
  // launcher pins only it.
  await writeFile(
    join(launcherDirectory, 'package.json'),
    `${JSON.stringify(launcherManifest(manifest, version, [host]), null, 2)}\n`,
  );
  const platformDirectory = join(scratch, 'platform');
  await stagePlatformPackage({
    binary,
    directory: platformDirectory,
    manifest,
    platform: host,
    version,
  });

  const tarballs = join(scratch, 'tarballs');
  await mkdir(tarballs);
  const launcherTarball = await pack(launcherDirectory, tarballs);
  const platformTarball = await pack(platformDirectory, tarballs);
  const platformFiles = platformTarball.files.map(({ path }) => path).sort();
  assert(
    JSON.stringify(platformFiles) ===
      JSON.stringify([
        'LICENSE',
        'README.md',
        `bin/${executableName(host)}`,
        'package.json',
      ]),
    `Unexpected ${platformPackageName(host)} files: ${platformFiles.join(', ')}`,
  );
  if (!windows) {
    const executable = platformTarball.files.find(({ path }) =>
      path.startsWith('bin/'),
    );
    assert(
      (executable.mode & 0o111) !== 0,
      'The packed executable is not executable',
    );
  }

  const consumer = join(scratch, 'consumer');
  await mkdir(consumer);
  await writeFile(
    join(consumer, 'package.json'),
    JSON.stringify({
      private: true,
      dependencies: {
        '@klex/machine': `file:${launcherTarball.path}`,
        [platformPackageName(host)]: `file:${platformTarball.path}`,
      },
    }),
  );
  await npm(
    ['install', '--offline', '--no-audit', '--no-fund', '--ignore-scripts'],
    { cwd: consumer },
  );

  const launcher = join(
    consumer,
    'node_modules',
    '@klex',
    'machine',
    'bin',
    'klex-machine.js',
  );
  const expectedVersion = (await run(binary, ['--version'])).trim();
  const shim = join(
    consumer,
    'node_modules',
    '.bin',
    windows ? 'klex-machine.cmd' : 'klex-machine',
  );
  assert(existsSync(shim), `npm did not link ${shim}`);
  // Node only starts a `.cmd` file through a shell.
  const reported = (await run(shim, ['--version'], { shell: windows })).trim();
  assert(
    reported === expectedVersion,
    `klex-machine --version printed ${reported}, expected ${expectedVersion}`,
  );

  const failing = spawn(process.execPath, [launcher, 'nope'], {
    stdio: 'ignore',
  });
  const failed = await new Promise((done) => failing.once('exit', done));
  assert(failed === 1, `An invalid command exited with ${failed}, expected 1`);

  // A supervisor signals the launcher alone; a terminal's Ctrl+C reaches the
  // launcher and the executable together. Both must shut down gracefully,
  // which releases the notification store's lock.
  const cases = windows
    ? [['tree', null]]
    : [
        ['launcher', 'SIGTERM'],
        ['launcher', 'SIGINT'],
        ['group', 'SIGINT'],
        ['group', 'SIGTERM'],
      ];
  for (const [target, signal] of cases) {
    const dataDir = await mkdtemp(join(scratch, 'data-'));
    const server = await startServer(launcher, dataDir, target === 'group');
    const health = await fetch(`http://127.0.0.1:${server.port}/health`);
    assert(health.ok, `/health answered ${health.status}`);
    assert(
      existsSync(join(dataDir, 'notifications', 'lock')),
      'The running server holds no notification store lock',
    );
    // Windows has no signal to forward, so stop the launcher and the
    // executable together.
    if (target === 'tree')
      await run('taskkill', ['/T', '/F', '/PID', String(server.child.pid)]);
    else
      process.kill(
        target === 'group' ? -server.child.pid : server.child.pid,
        signal,
      );
    const exit = await within(
      server.exited,
      15_000,
      `The server ignored ${signal} sent to the ${target}`,
    );
    if (signal) {
      assert(
        exit.signal === signal || exit.code === 0,
        `${signal} to the ${target} ended the launcher with ${JSON.stringify(exit)}`,
      );
      assert(
        !existsSync(join(dataDir, 'notifications', 'lock')),
        `${signal} to the ${target} did not shut the server down gracefully`,
      );
    }
    console.log(
      `Shutdown on ${signal ?? 'kill'} of the ${target}: ${JSON.stringify(exit)}`,
    );
  }
  console.log(
    `Verified @klex/machine with ${platformPackageName(host)} (${expectedVersion})`,
  );
} finally {
  await rm(scratch, { force: true, recursive: true, maxRetries: 10 });
}
