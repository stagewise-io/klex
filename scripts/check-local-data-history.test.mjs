import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import {
  checkAppendOnly,
  checkBoundary,
  checkGraph,
  FIXTURES,
  HISTORY,
  parseRegistry,
  validateHistory,
} from './check-local-data-history.mjs';

const migration = `${HISTORY}example-v1-v2.ts`;
const contracts = `${HISTORY}contracts.ts`;
const registryPath = `${HISTORY}local-data-history.ts`;
const source = `import { step } from './example-v1-v2';
import { schema1, schema2 } from './contracts';
export const LOCAL_DATA_HISTORY = { example: { versions: [schema1, schema2], migrations: [step] } };`;
const baseline = () =>
  new Map([
    [registryPath, source],
    [
      migration,
      "import type { JsonMigration } from '@/local-data';\nexport const step: JsonMigration = { from: 1, to: 2, name: 'test', up: (value) => value };",
    ],
    [
      contracts,
      'export const schema1 = { version: 1, schema: null }; export const schema2 = { version: 2, schema: null };',
    ],
    [`${FIXTURES}example.json`, '{"old":true}'],
  ]);

test('accepts unchanged history and bootstraps extraction', () => {
  validateHistory(baseline(), baseline());
  validateHistory(new Map(), baseline());
});

for (const action of ['edit', 'delete', 'rename']) {
  for (const path of [migration, contracts, `${FIXTURES}example.json`]) {
    test(`rejects ${action} of ${path}`, () => {
      const current = baseline();
      if (action === 'edit') current.set(path, `${current.get(path)}\n`);
      else current.delete(path);
      if (action === 'rename')
        current.set(`${path}.renamed`, baseline().get(path));
      assert.throws(
        () => validateHistory(baseline(), current),
        /Immutable history/,
      );
    });
  }
}

for (const replacement of [
  '[]',
  '[schema2, schema1]',
  '[schema1]',
  '[schema1, schema1]',
]) {
  test(`rejects changed registration ${replacement}`, () => {
    const current = baseline();
    current.set(
      registryPath,
      source.replace('[schema1, schema2]', replacement),
    );
    assert.throws(
      () => validateHistory(baseline(), current),
      /immutable prefix/,
    );
  });
}

test('rejects removed store and replaced import binding', () => {
  assert.throws(
    () => checkAppendOnly(parseRegistry(source), {}),
    /immutable prefix/,
  );
  assert.throws(
    () =>
      checkAppendOnly(
        parseRegistry(source),
        parseRegistry(source.replace('./example-v1-v2', './replacement')),
      ),
    /immutable prefix/,
  );
});

test('allows a new contiguous step and schema without touching old files', () => {
  const current = baseline();
  const next = `${HISTORY}example-v2-v3.ts`;
  current.set(
    next,
    "import type { JsonMigration } from '@/local-data';\nexport const next: JsonMigration = { from: 2, to: 3, name: 'next', up: (value) => value };",
  );
  current.set(
    `${HISTORY}schema3.ts`,
    'export const schema3 = { version: 3, schema: null };',
  );
  current.set(
    registryPath,
    `import { next } from './example-v2-v3'; import { schema3 } from './schema3'; ${source.replace('[schema1, schema2]', '[schema1, schema2, schema3]').replace('[step]', '[step, next]')}`,
  );
  validateHistory(baseline(), current);
  for (const body of [
    current.get(next).replace('from: 2', 'from: 3'),
    current.get(next).replace('to: 3', 'to: 4'),
  ]) {
    current.set(next, body);
    assert.throws(() => validateHistory(baseline(), current), /non-contiguous/);
  }
});

test('rejects inconsistent version counts and latest historical version', () => {
  const registry = parseRegistry(source);
  assert.throws(
    () =>
      checkGraph({ example: { ...registry.example, versions: [] } }, () =>
        baseline().get(migration),
      ),
    /count mismatch/,
  );
  assert.throws(
    () =>
      checkGraph(registry, (path) =>
        baseline().get(path).replace('version: 2', 'version: 3'),
      ),
    /non-contiguous historical/,
  );
});

for (const code of [
  "import { schema } from '@/config';",
  "import{schema}from'@/config';",
  "export*from'@/config';",
  "import /* comment */ { schema } from '@/config';",
  "export { schema } from '@/config';",
  "import type { KlexConfig } from '@/config';",
  "import { schema } from '../config/types';",
  "import { schema } from './missing';",
  "import { JsonMigration } from '@/local-data';",
  "import './side-effect';",
  "const code = import('@/config');",
  "const code = require('@/config');",
]) {
  test(`rejects mutable dependency: ${code}`, () =>
    assert.throws(() =>
      checkBoundary(migration, code, new Set([migration, contracts])),
    ));
}

test('allows zod, frozen local helpers, and narrowly scoped type imports', () => {
  for (const code of [
    "import { z } from 'zod';",
    "import { schema } from './contracts';",
    "import type { JsonMigration, SqliteMigration } from '@/local-data';",
  ])
    checkBoundary(migration, code, new Set([migration, contracts]));
});

for (const replacement of [
  'export const LOCAL_DATA_HISTORY = getRegistry();',
  'export const LOCAL_DATA_HISTORY = { example: { migrations: [...steps] } };',
  'export const LOCAL_DATA_HISTORY = { example: { migrations: [step, step()] } };',
  'export const LOCAL_DATA_HISTORY = {}; console.log(1);',
]) {
  test(`fails closed for dynamic registry: ${replacement}`, () =>
    assert.throws(() => parseRegistry(replacement)));
}

test('reads trusted Git blobs and detects worktree edits, deletions and renames', () => {
  const root = mkdtempSync(join(tmpdir(), 'klex-history-guard-'));
  const write = (path, contents) => {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  };
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  try {
    write(
      'scripts/check-local-data-history.mjs',
      readFileSync(
        new URL('./check-local-data-history.mjs', import.meta.url),
        'utf8',
      ),
    );
    for (const [path, contents] of baseline()) write(path, contents);
    git('init', '-q');
    git('add', '.');
    git(
      '-c',
      'user.name=Migration guard tests',
      '-c',
      'user.email=tests@example.invalid',
      'commit',
      '-qm',
      'Initial frozen history',
    );
    const sha = git('rev-parse', 'HEAD');
    const run = () =>
      spawnSync(
        process.execPath,
        ['scripts/check-local-data-history.mjs', sha],
        { cwd: root, encoding: 'utf8' },
      );
    assert.equal(run().status, 0);
    for (const action of ['edit', 'delete', 'rename']) {
      if (action === 'edit') write(migration, `${baseline().get(migration)}\n`);
      if (action === 'delete') rmSync(join(root, migration));
      if (action === 'rename')
        renameSync(join(root, migration), join(root, `${migration}.renamed`));
      const result = run();
      assert.notEqual(result.status, 0, action);
      assert.match(result.stderr, /Immutable history/);
      if (action === 'rename') rmSync(join(root, `${migration}.renamed`));
      write(migration, baseline().get(migration));
    }
    write(`${HISTORY}new-helper.ts`, "import{schema}from'@/config';");
    assert.match(run().stderr, /mutable or unsupported dependency/);
    rmSync(join(root, `${HISTORY}new-helper.ts`));
    assert.equal(run().status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fails closed when a trusted baseline is missing or invalid', () => {
  for (const base of [undefined, 'not-a-real-reference', '--help']) {
    const result = spawnSync(
      process.execPath,
      ['scripts/check-local-data-history.mjs', ...(base ? [base] : [])],
      { encoding: 'utf8' },
    );
    assert.notEqual(result.status, 0);
  }
});
