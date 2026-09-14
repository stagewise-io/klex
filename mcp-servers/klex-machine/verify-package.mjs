import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const packageRoot = resolve(import.meta.dirname);
const temporaryRoot = await mkdtemp(join(tmpdir(), 'klex-machine-package-'));
let child;

try {
  await run('pnpm', ['build'], packageRoot);
  const packed = JSON.parse(
    await run(
      'npm',
      [
        'pack',
        '--json',
        '--pack-destination',
        temporaryRoot,
        '--ignore-scripts',
      ],
      packageRoot,
    ),
  );
  const metadata = packed[0];
  if (!metadata?.filename || !Array.isArray(metadata.files)) {
    throw new Error('npm pack did not return package metadata');
  }
  const allowed = new Set([
    'LICENSE',
    'README.md',
    'dist/index.js',
    'dist/index.js.map',
    'package.json',
  ]);
  const unexpected = metadata.files
    .map((file) => file.path)
    .filter((path) => !allowed.has(path));
  if (unexpected.length > 0) {
    throw new Error(`Unexpected packed files: ${unexpected.join(', ')}`);
  }
  for (const required of allowed) {
    if (!metadata.files.some((file) => file.path === required)) {
      throw new Error(`Packed file is missing: ${required}`);
    }
  }

  const executable = join(packageRoot, 'dist', 'index.js');
  const executableMetadata = metadata.files.find(
    (file) => file.path === 'dist/index.js',
  );
  const source = await readFile(executable, 'utf8');
  if (!source.startsWith('#!/usr/bin/env node\n')) {
    throw new Error('Built executable is missing its Node shebang');
  }
  if (
    process.platform !== 'win32' &&
    (!executableMetadata?.mode || (executableMetadata.mode & 0o111) === 0)
  ) {
    throw new Error('Packed executable does not have an executable mode');
  }

  const consumer = join(temporaryRoot, 'consumer');
  await mkdir(consumer);
  await writeFile(
    join(temporaryRoot, 'package.json'),
    JSON.stringify({ private: true }),
  );
  await run(
    'npm',
    ['install', join(temporaryRoot, metadata.filename)],
    temporaryRoot,
  );
  const installedEntry = join(
    temporaryRoot,
    'node_modules',
    'klex-machine',
    'dist',
    'index.js',
  );
  const version = (
    await run(process.execPath, [installedEntry, '--version'], consumer)
  ).trim();
  if (version !== '0.1.0')
    throw new Error(`Unexpected CLI version: ${version}`);
  const help = await run(
    process.execPath,
    [installedEntry, '--help'],
    consumer,
  );
  if (!help.includes('klex-machine serve [options]')) {
    throw new Error('Installed CLI help is incomplete');
  }

  const port = await availablePort();
  child = spawn(
    process.execPath,
    [installedEntry, 'serve', '--cwd', consumer, '--port', String(port)],
    { cwd: consumer, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let childError = '';
  child.stderr.on('data', (chunk) => {
    childError += String(chunk);
  });
  await waitForHealth(port, child, () => childError);

  const write = await callTool(port, 'write', {
    path: 'package-smoke.txt',
    content: 'package-ok',
  });
  if (write.isError) throw new Error('Packed filesystem tool failed');
  const read = parseToolText(
    await callTool(port, 'read', { path: 'package-smoke.txt' }),
  );
  if (read.content !== 'package-ok')
    throw new Error('Packed filesystem read mismatch');

  const session = parseToolText(await callTool(port, 'createShellSession', {}));
  await callTool(port, 'writeShellSession', {
    id: session.id,
    data: 'printf package-shell-ok\\n',
  });
  const shellRead = parseToolText(
    await callTool(port, 'readShellSession', {
      id: session.id,
      cursor: 0,
      waitMs: 1_000,
    }),
  );
  if (!shellRead.output.includes('package-shell-ok')) {
    throw new Error('Packed shell smoke command produced no output');
  }
  await callTool(port, 'closeShellSession', { id: session.id });

  process.stdout.write('Packed klex-machine verification passed\n');
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
  await rm(temporaryRoot, { recursive: true, force: true });
}

function run(command, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const process = spawn(command, args, {
      cwd,
      env: { ...globalThis.process.env, NO_COLOR: '1' },
      shell: processPlatformNeedsShell(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    process.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    process.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    process.once('error', reject);
    process.once('exit', (code) => {
      if (code === 0) resolvePromise(stdout);
      else
        reject(
          new Error(
            `${command} ${args.join(' ')} failed (${code}):\n${stderr || stdout}`,
          ),
        );
    });
  });
}

function processPlatformNeedsShell() {
  return process.platform === 'win32';
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Could not allocate port');
  await new Promise((resolvePromise) => server.close(resolvePromise));
  return address.port;
}

async function waitForHealth(port, serverProcess, errorOutput) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (serverProcess.exitCode !== null) {
      throw new Error(
        `Packed server exited early (${serverProcess.exitCode}): ${errorOutput()}`,
      );
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`Timed out waiting for packed server: ${errorOutput()}`);
}

async function callTool(port, name, arguments_) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: arguments_ },
    }),
  });
  const body = await response.text();
  const data = body
    .split('\n')
    .find((line) => line.startsWith('data: '))
    ?.slice(6);
  const parsed = JSON.parse(data ?? body);
  if (parsed.error)
    throw new Error(`MCP error: ${JSON.stringify(parsed.error)}`);
  return parsed.result;
}

function parseToolText(result) {
  if (result.isError)
    throw new Error(result.content?.[0]?.text ?? 'Tool failed');
  return JSON.parse(result.content?.[0]?.text ?? 'null');
}
