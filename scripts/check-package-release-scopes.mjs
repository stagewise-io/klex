import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { commitHasScope } from './scoped-release-plugin.mjs';

const scriptDirectory = fileURLToPath(new URL('.', import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');

export const publishablePackages = [
  {
    path: 'packages/agent-admin-api/',
    scope: 'agent-admin-api',
  },
  {
    path: 'packages/mcp-proxy-sdk/',
    scope: 'mcp-proxy-sdk',
  },
  {
    path: 'mcp-servers/klex-machine/',
    scope: 'machine',
  },
];

export function scopesForChangedFiles(files) {
  return publishablePackages
    .filter(({ path }) => files.some((file) => file.startsWith(path)))
    .map(({ scope }) => scope);
}

export function missingReleaseScopes(scopes, commits) {
  return scopes.filter(
    (scope) =>
      !commits.some(
        ({ changedFiles, message }) =>
          changedFiles.length > 0 && commitHasScope(message, scope),
      ),
  );
}

export async function checkGeneratedContract({
  baseRef,
  root = repositoryRoot,
  run = runCommand,
}) {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), 'klex-admin-api-release-'),
  );
  const baseWorktree = join(temporaryRoot, 'base');

  try {
    await run(
      'git',
      ['worktree', 'add', '--detach', baseWorktree, baseRef],
      root,
    );
    await run(
      'pnpm',
      ['install', '--frozen-lockfile', '--ignore-scripts'],
      baseWorktree,
    );
    const buildContractArgs = [
      'exec',
      'turbo',
      'run',
      'build',
      '--filter=@klex/agent-admin-api',
    ];
    await run('pnpm', buildContractArgs, root);
    await run('pnpm', buildContractArgs, baseWorktree);

    const relativeContractPath = join('dist', 'index.d.ts');
    const headContract = await readFile(
      join(root, 'packages', 'agent-admin-api', relativeContractPath),
      'utf8',
    );
    const baseContract = await readFile(
      join(baseWorktree, 'packages', 'agent-admin-api', relativeContractPath),
      'utf8',
    );

    return headContract === baseContract;
  } finally {
    await run(
      'git',
      ['worktree', 'remove', '--force', baseWorktree],
      root,
    ).catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export function runCommand(command, args, cwd = repositoryRoot) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
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

async function main() {
  const [baseRef] = process.argv.slice(2);
  if (!baseRef) {
    throw new Error(
      'Usage: node scripts/check-package-release-scopes.mjs <base-ref>',
    );
  }

  const changedFiles = (
    await runCommand('git', ['diff', '--name-only', `${baseRef}...HEAD`])
  )
    .trim()
    .split('\n')
    .filter(Boolean);
  const requiredScopes = scopesForChangedFiles(changedFiles);

  const contractsMatch = await checkGeneratedContract({ baseRef });
  if (!contractsMatch && !requiredScopes.includes('agent-admin-api')) {
    requiredScopes.push('agent-admin-api');
  }

  if (requiredScopes.length === 0) {
    process.stdout.write('No publishable package changes detected\n');
    return;
  }

  const commitRecords = (
    await runCommand('git', [
      'log',
      '--format=%H%x1f%B%x00',
      `${baseRef}..HEAD`,
    ])
  )
    .split('\0')
    .map((record) => record.trim())
    .filter(Boolean);
  const commits = await Promise.all(
    commitRecords.map(async (record) => {
      const separatorIndex = record.indexOf('\x1f');
      const hash = record.slice(0, separatorIndex);
      const message = record.slice(separatorIndex + 1);
      const changedFiles = (
        await runCommand('git', [
          'diff-tree',
          '--no-commit-id',
          '--name-only',
          '-r',
          hash,
        ])
      )
        .trim()
        .split('\n')
        .filter(Boolean);
      return { changedFiles, message };
    }),
  );
  const missing = missingReleaseScopes(requiredScopes, commits);

  if (missing.length > 0) {
    throw new Error(
      `Publishable package changes require release-triggering commit scopes: ${missing.join(', ')}`,
    );
  }

  process.stdout.write(
    `Release-triggering scopes found: ${requiredScopes.join(', ')}\n`,
  );
}

const isDirectRun =
  process.argv[1] &&
  pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
if (isDirectRun) {
  await main();
}
