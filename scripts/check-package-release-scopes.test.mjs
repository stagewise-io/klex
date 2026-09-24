import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  checkGeneratedContract,
  missingReleaseScopes,
  normalizeDeclarations,
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
    ['agent-admin-api', 'mcp-proxy-sdk', 'machine'],
  );
  assert.deepEqual(
    publishablePackages.map(({ scope }) => scope),
    ['agent-admin-api', 'mcp-proxy-sdk', 'machine'],
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
      ['agent-admin-api', 'mcp-proxy-sdk', 'machine'],
      [
        {
          changedFiles: ['packages/agent-admin-api/src/index.ts'],
          message: 'fix(agent-admin-api): repair types',
        },
        {
          changedFiles: ['packages/mcp-proxy-sdk/src/index.ts'],
          message: 'feat(klex,mcp-proxy-sdk): add routing',
        },
        {
          changedFiles: ['mcp-servers/klex-machine/README.md'],
          message: 'docs(machine): document setup',
        },
      ],
    ),
    [],
  );
});

test('reports missing scopes and rejects lookalikes', () => {
  assert.deepEqual(
    missingReleaseScopes(
      ['agent-admin-api', 'mcp-proxy-sdk', 'machine'],
      [
        {
          changedFiles: ['packages/agent-admin-api/src/index.ts'],
          message: 'fix(agent-admin-api-client): repair client',
        },
        {
          changedFiles: ['packages/mcp-proxy-sdk/src/index.ts'],
          message: 'fix(mcp-proxy-sdk-extra): repair proxy',
        },
        {
          changedFiles: ['mcp-servers/klex-machine/src/index.ts'],
          message: 'fix: repair machine',
        },
      ],
    ),
    ['agent-admin-api', 'mcp-proxy-sdk', 'machine'],
  );
});

test('rejects scoped commits that do not change files', () => {
  assert.deepEqual(
    missingReleaseScopes(
      ['machine'],
      [{ changedFiles: [], message: 'feat(machine): empty release marker' }],
    ),
    ['machine'],
  );
});

async function checkContractFixture(baseContract) {
  const root = await mkdtemp(join(tmpdir(), 'release-scope-test-'));
  const contractPath = join(
    'packages',
    'agent-admin-api',
    'dist',
    'index.d.ts',
  );
  const commands = [];

  try {
    await mkdir(join(root, 'packages', 'agent-admin-api', 'dist'), {
      recursive: true,
    });
    await writeFile(join(root, contractPath), HEAD_CONTRACT);
    const run = async (command, args, cwd) => {
      commands.push({ command, args, cwd });
      if (
        command === 'git' &&
        args.slice(0, 3).join(' ') === 'worktree add --detach'
      ) {
        const baseWorktree = args[3];
        await mkdir(join(baseWorktree, 'packages', 'agent-admin-api', 'dist'), {
          recursive: true,
        });
        await writeFile(join(baseWorktree, contractPath), baseContract);
      }
    };

    const matches = await checkGeneratedContract({
      baseRef: 'base',
      root,
      run,
    });
    return { commands, matches };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const HEAD_CONTRACT = `export type Route = {
    status: 200;
    output: { id: string };
} | {
    status: 500;
    output: { error: string; code: string | number };
};
`;

const sameContract = (a, b) =>
  normalizeDeclarations(a) === normalizeDeclarations(b);

test('treats reordered unions as the same contract', () => {
  assert.ok(
    sameContract(
      HEAD_CONTRACT,
      `export type Route = {
    status: 500;
    output: { error: string; code: number | string };
} | {
    status: 200;
    output: { id: string };
};
`,
    ),
  );
  assert.ok(
    sameContract(
      'export declare const f: (() => void) | string | null;',
      '/** doc */\nexport declare const f:\n  | null\n  | string\n  | (() => void);',
    ),
  );
});

test('detects real contract changes', () => {
  const base = 'export type T = { a: string; b: 200 | 404 };';
  for (const changed of [
    'export type T = { a: string; b: 200 | 404; c: string };',
    'export type T = { a?: string; b: 200 | 404 };',
    'export type T = { a: string; b: 201 | 404 };',
    'export type T = { a: string; b: 200 | 404 | 500 };',
    'export type T = { a: string | undefined; b: 200 | 404 };',
    'export type U = { a: string; b: 200 | 404 };',
  ]) {
    assert.equal(sameContract(base, changed), false, changed);
  }
  assert.equal(
    sameContract(
      'export type F = ((x: string) => 1) & ((x: number) => 2);',
      'export type F = ((x: number) => 2) & ((x: string) => 1);',
    ),
    false,
  );
});

test('compares matching and changed generated Admin API contracts', async () => {
  const matching = await checkContractFixture(HEAD_CONTRACT);
  const changed = await checkContractFixture(
    HEAD_CONTRACT.replace('status: 200', 'status: 201'),
  );

  assert.equal(matching.matches, true);
  assert.equal(changed.matches, false);
  assert.equal(matching.commands[0].command, 'git');
  assert.deepEqual(matching.commands[0].args.slice(0, 3), [
    'worktree',
    'add',
    '--detach',
  ]);
  assert.ok(
    matching.commands.some(
      ({ command, args }) =>
        command === 'pnpm' &&
        args.join(' ') === 'install --frozen-lockfile --ignore-scripts',
    ),
  );
  assert.equal(
    matching.commands.filter(
      ({ command, args }) =>
        command === 'pnpm' &&
        args.join(' ') ===
          'exec turbo run build --filter=@klex/agent-admin-api',
    ).length,
    2,
  );
  assert.ok(
    matching.commands.some(
      ({ command, args }) =>
        command === 'git' &&
        args.slice(0, 3).join(' ') === 'worktree remove --force',
    ),
  );
});
