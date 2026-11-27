import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  affectedGroups,
  groups,
  packagePaths,
  readWorkspace,
} from './ci-changes.mjs';

const workspace = readWorkspace();
const none = Object.fromEntries(Object.keys(groups).map((g) => [g, false]));
const affected = (files) => affectedGroups(files, workspace);

test('documentation and website changes affect no gated group', () => {
  assert.deepEqual(
    affected([
      'README.md',
      'apps/website/src/main.ts',
      'apps/docs/content/index.md',
      'scripts/agent-site/agent-site.mjs',
    ]),
    none,
  );
});

test('global inputs affect every group', () => {
  for (const file of [
    'pnpm-lock.yaml',
    '.github/workflows/ci.yml',
    '.github/actions/setup-rust/action.yml',
    '.github/actions/setup-tauri-linux/action.yml',
    'scripts/generated-schema-output.ts',
  ]) {
    assert.ok(
      Object.values(affected([file])).every(Boolean),
      `${file} should affect every group`,
    );
  }
});

test('klex app changes affect only the executable group', () => {
  assert.deepEqual(affected(['apps/klex/src/index.ts']), {
    ...none,
    executable: true,
  });
});

test('shared dependencies reach every package that depends on them', () => {
  assert.deepEqual(affected(['packages/mcp-extension-client/src/index.ts']), {
    ...none,
    executable: true,
  });
});

test('Rust changes affect the machine and desktop groups', () => {
  for (const file of [
    'Cargo.lock',
    'mcp-servers/klex-machine/src/lib.rs',
    'mcp-servers/klex-machine/definitions/server.json',
  ]) {
    assert.deepEqual(affected([file]), {
      ...none,
      machine: true,
      desktop: true,
    });
  }
});

test('desktop app changes affect only the desktop group', () => {
  assert.deepEqual(affected(['apps/desktop/src-tauri/src/lib.rs']), {
    ...none,
    desktop: true,
  });
  assert.deepEqual(affected(['apps/desktop/src/main.tsx']), {
    ...none,
    desktop: true,
  });
  assert.deepEqual(
    affected(['apps/desktop/scripts/release/verify-windows.ps1']),
    { ...none, desktop: true },
  );
});

test('the desktop release workflow affects the desktop group', () => {
  assert.deepEqual(affected(['.github/workflows/_release-klex-desktop.yml']), {
    ...none,
    desktop: true,
  });
});

test('npm launcher changes affect the machine and desktop groups', () => {
  assert.deepEqual(affected(['mcp-servers/klex-machine/bin/klex-machine.js']), {
    ...none,
    machine: true,
    desktop: true,
  });
});

test('installer changes affect only the installer group', () => {
  assert.deepEqual(affected(['install.sh']), { ...none, installer: true });
  assert.deepEqual(affected(['scripts/install-lock-e2e.ps1']), {
    ...none,
    installer: true,
  });
});

test('package closures follow workspace dependencies transitively', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ci-changes-'));
  try {
    await writeFile(
      join(root, 'pnpm-workspace.yaml'),
      'packages:\n  - apps/*\n  # comment\n  - packages/*\n\nallowBuilds:\n  esbuild: true\n',
    );
    const manifests = {
      'apps/app': { name: 'app', dependencies: { b: 'workspace:*' } },
      'packages/b': { name: 'b', devDependencies: { c: 'workspace:^' } },
      'packages/c': { name: 'c', dependencies: { left: '1.0.0' } },
      'packages/unrelated': { name: 'unrelated' },
    };
    for (const [path, manifest] of Object.entries(manifests)) {
      await mkdir(join(root, path), { recursive: true });
      await writeFile(
        join(root, path, 'package.json'),
        JSON.stringify(manifest),
      );
    }
    await mkdir(join(root, 'packages/no-manifest'));

    const fixture = readWorkspace(root);
    assert.deepEqual(packagePaths(fixture, ['app']), [
      'apps/app/',
      'packages/b/',
      'packages/c/',
    ]);
    assert.throws(() => packagePaths(fixture, ['missing']), /Unknown/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('every configured package exists in the workspace', () => {
  for (const { packages = [] } of Object.values(groups)) {
    packagePaths(workspace, packages);
  }
});
