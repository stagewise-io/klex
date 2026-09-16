import assert from 'node:assert/strict';
import test from 'node:test';

import {
  checkGeneratedContract,
  missingReleaseScopes,
  publishablePackages,
  scopesForChangedFiles,
} from './check-package-release-scopes.mjs';

test('maps changes to each publishable package scope', () => {
  assert.deepEqual(
    scopesForChangedFiles([
      'packages/agent-admin-api/src/index.ts',
      'packages/mcp-proxy-sdk/src/core/index.ts',
      'mcp-servers/klex-machine/src/index.ts',
      'README.md',
    ]),
    ['agent-admin-api', 'mcp-proxy-sdk', 'klex-machine'],
  );
  assert.deepEqual(
    publishablePackages.map(({ scope }) => scope),
    ['agent-admin-api', 'mcp-proxy-sdk', 'klex-machine'],
  );
});

test('ignores unrelated and path-prefix lookalike changes', () => {
  assert.deepEqual(
    scopesForChangedFiles([
      'packages/mcp-proxy-sdk-extra/src/index.ts',
      'mcp-servers/klex-machine-old/src/index.ts',
      'apps/klex/src/index.ts',
    ]),
    [],
  );
});

test('accepts exact scopes across the complete commit range', () => {
  assert.deepEqual(
    missingReleaseScopes(
      ['agent-admin-api', 'mcp-proxy-sdk', 'klex-machine'],
      [
        'fix(agent-admin-api): repair types',
        'feat(klex,mcp-proxy-sdk): add routing',
        'docs(klex-machine): document setup',
      ],
    ),
    [],
  );
});

test('reports missing scopes and rejects lookalikes', () => {
  assert.deepEqual(
    missingReleaseScopes(
      ['agent-admin-api', 'mcp-proxy-sdk', 'klex-machine'],
      [
        'fix(agent-admin-api-client): repair client',
        'fix(mcp-proxy-sdk-extra): repair proxy',
        'fix: repair machine',
      ],
    ),
    ['agent-admin-api', 'mcp-proxy-sdk', 'klex-machine'],
  );
});

test('compares generated Admin API contracts from base and current checkout', async () => {
  const commands = [];
  const run = async (command, args, cwd) => {
    commands.push({ command, args, cwd });
  };

  await assert.rejects(
    checkGeneratedContract({
      baseRef: 'base',
      root: '/missing/repository',
      run,
    }),
  );
  assert.equal(commands[0].command, 'git');
  assert.deepEqual(commands[0].args.slice(0, 3), [
    'worktree',
    'add',
    '--detach',
  ]);
  assert.ok(
    commands.some(
      ({ command, args }) =>
        command === 'pnpm' && args.join(' ') === 'build:contract',
    ),
  );
  assert.ok(
    commands.some(
      ({ command, args }) =>
        command === 'git' &&
        args.slice(0, 3).join(' ') === 'worktree remove --force',
    ),
  );
});
