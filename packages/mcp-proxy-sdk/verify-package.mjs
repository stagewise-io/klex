import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const packageRoot = resolve(import.meta.dirname);
const repositoryRoot = resolve(packageRoot, '../..');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'mcp-proxy-sdk-package-'));

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

  const unexpected = metadata.files
    .map((file) => file.path)
    .filter(
      (path) =>
        !['LICENSE', 'README.md', 'package.json'].includes(path) &&
        !/^dist\/.+\.(?:js|js\.map|d\.ts|d\.ts\.map)$/.test(path),
    );
  if (unexpected.length > 0) {
    throw new Error(`Unexpected packed files: ${unexpected.join(', ')}`);
  }

  const manifest = JSON.parse(
    await readFile(join(packageRoot, 'package.json'), 'utf8'),
  );
  const packedPaths = new Set(metadata.files.map((file) => file.path));
  for (const required of ['LICENSE', 'README.md', 'package.json']) {
    if (!packedPaths.has(required)) {
      throw new Error(`Packed file is missing: ${required}`);
    }
  }
  for (const [subpath, exported] of Object.entries(manifest.exports)) {
    for (const field of ['types', 'default']) {
      const target = exported[field]?.replace(/^\.\//, '');
      if (!target || !packedPaths.has(target)) {
        throw new Error(`Export ${subpath}.${field} is missing: ${target}`);
      }
    }
  }

  await writeFile(
    join(temporaryRoot, 'package.json'),
    JSON.stringify({ private: true, type: 'module' }),
  );
  await run(
    'npm',
    [
      'install',
      join(temporaryRoot, metadata.filename),
      '--ignore-scripts',
      '--no-package-lock',
    ],
    temporaryRoot,
  );

  const installedManifestPath = join(
    temporaryRoot,
    'node_modules',
    '@klex',
    'mcp-proxy-sdk',
    'package.json',
  );
  const installedManifest = JSON.parse(
    await readFile(installedManifestPath, 'utf8'),
  );
  for (const field of [
    'dependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    const leaked = Object.entries(installedManifest[field] ?? {}).filter(
      ([, version]) => version.startsWith('workspace:'),
    );
    if (leaked.length > 0) {
      throw new Error(
        `Packed ${field} contain workspace dependencies: ${leaked
          .map(([name]) => name)
          .join(', ')}`,
      );
    }
  }

  await writeFile(
    join(temporaryRoot, 'consumer.ts'),
    [
      "import * as core from '@klex/mcp-proxy-sdk/core';",
      "import * as http from '@klex/mcp-proxy-sdk/http';",
      "import * as server from '@klex/mcp-proxy-sdk/server';",
      "import * as daemon from '@klex/mcp-proxy-sdk/daemon/node';",
      'void [core, http, server, daemon];',
      '',
    ].join('\n'),
  );
  await writeFile(
    join(temporaryRoot, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        noEmit: true,
        skipLibCheck: false,
        strict: true,
        target: 'ES2022',
      },
      include: ['consumer.ts'],
    }),
  );
  await run(
    process.execPath,
    [
      join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      '--project',
      join(temporaryRoot, 'tsconfig.json'),
    ],
    temporaryRoot,
  );

  await writeFile(
    join(temporaryRoot, 'runtime-smoke.mjs'),
    [
      "await import('@klex/mcp-proxy-sdk/core');",
      "await import('@klex/mcp-proxy-sdk/http');",
      "await import('@klex/mcp-proxy-sdk/server');",
      "await import('@klex/mcp-proxy-sdk/daemon/node');",
      '',
    ].join('\n'),
  );
  await run(
    process.execPath,
    [join(temporaryRoot, 'runtime-smoke.mjs')],
    temporaryRoot,
  );

  process.stdout.write('Packed MCP Proxy SDK verification passed\n');
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

function run(command, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, CI: '1' },
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolvePromise(stdout);
      else {
        reject(
          new Error(
            `${command} ${args.join(' ')} failed with ${code}\n${stdout}${stderr}`,
          ),
        );
      }
    });
  });
}
