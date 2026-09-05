import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { commitHasScope } from '../packages/agent-admin-api/release-plugin.mjs';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const declarationPath = join(
  'packages',
  'agent-admin-api',
  'dist',
  'index.d.ts',
);

function run(command, args, cwd = repositoryRoot, options = {}) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
  });
}

function buildContract(cwd) {
  run(
    'pnpm',
    ['exec', 'turbo', 'run', 'build', '--filter', '@klex/agent-admin-api'],
    cwd,
  );
}

export function commitsDeclareScope(commits, scope) {
  return commits.some(
    ({ changedFiles, message }) =>
      changedFiles.length > 0 && commitHasScope(message, scope),
  );
}

async function check(baseRef) {
  run('git', ['merge-base', '--is-ancestor', baseRef, 'HEAD']);

  buildContract(repositoryRoot);
  const headContract = await readFile(join(repositoryRoot, declarationPath));
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), 'agent-admin-api-base-'),
  );
  const baseCheckout = join(temporaryDirectory, 'repository');
  let worktreeCreated = false;

  try {
    run('git', ['worktree', 'add', '--detach', baseCheckout, baseRef]);
    worktreeCreated = true;
    run('pnpm', ['install', '--frozen-lockfile'], baseCheckout);
    buildContract(baseCheckout);
    const baseContract = await readFile(join(baseCheckout, declarationPath));

    const changedPaths = run(
      'git',
      ['diff', '--name-only', `${baseRef}..HEAD`],
      repositoryRoot,
      { capture: true },
    )
      .split('\n')
      .filter(Boolean);
    const packageChanged = changedPaths.some((path) =>
      path.startsWith('packages/agent-admin-api/'),
    );
    const contractChanged = !headContract.equals(baseContract);

    if (!packageChanged && !contractChanged) {
      process.stdout.write(
        'Agent Admin API package and contract are unchanged.\n',
      );
      return;
    }

    const commitOutput = run(
      'git',
      ['log', '--format=%H%x1f%B%x00', `${baseRef}..HEAD`],
      repositoryRoot,
      { capture: true },
    );
    const commits = commitOutput
      .split('\0')
      .map((record) => record.trim())
      .filter(Boolean)
      .map((record) => {
        const [rawHash, message] = record.split('\x1f', 2);
        const hash = rawHash.trim();
        const changedFiles = run(
          'git',
          ['diff-tree', '--no-commit-id', '--name-only', '-r', hash],
          repositoryRoot,
          { capture: true },
        )
          .split('\n')
          .filter(Boolean);
        return { changedFiles, message };
      });

    if (!commitsDeclareScope(commits, 'agent-admin-api')) {
      throw new Error(
        'The Agent Admin API package or generated contract changed, but no non-empty commit includes the agent-admin-api scope. Use a commit such as feat(klex,agent-admin-api): describe the public API change.',
      );
    }

    process.stdout.write(
      'Agent Admin API change has a durable release-scoped commit.\n',
    );
  } finally {
    if (worktreeCreated) {
      run('git', ['worktree', 'remove', '--force', baseCheckout]);
    }
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  const baseRef = process.argv[2];
  if (!baseRef) {
    throw new Error(
      'Usage: node scripts/check-agent-admin-api-release.mjs <base-ref>',
    );
  }

  await check(baseRef);
}
