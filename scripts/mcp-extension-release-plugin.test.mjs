import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertBaseline,
  extensionPackages,
  prepareManifest,
  publishedHelperVersion,
  resolveRuntimeDependencies,
  verifyBaseline,
} from './mcp-extension-release-plugin.mjs';

const target = extensionPackages[1];

test('requires a reachable baseline matching the published version, not the source manifest', () => {
  assert.equal(
    assertBaseline({
      ...target,
      tags: [`${target.name}-v0.1.1`],
      publishedVersion: '0.1.1',
    }),
    '0.1.1',
  );
  for (const tags of [
    [],
    [`${target.name}-v0.1.0`],
    [`${target.name}-v0.1.2`, `${target.name}-v0.1.1`],
  ]) {
    assert.throws(
      () => assertBaseline({ ...target, tags, publishedVersion: '0.1.1' }),
      /verified historical or explicitly reconstructed baseline/,
    );
  }
});

test('baseline metadata providers are injectable without npm or publication', async () => {
  const calls = [];
  assert.equal(
    await verifyBaseline(target, '/fixture', {
      reachableTags: async (cwd, format) => {
        calls.push([cwd, format]);
        return [`${target.name}-v0.1.1`];
      },
      npmVersion: async (name) => {
        calls.push(name);
        return '0.1.1';
      },
    }),
    '0.1.1',
  );
  assert.deepEqual(calls, [['/fixture', target.tagFormat], target.name]);
});

test('resolves runtime workspace dependencies without mutating authored manifests', () => {
  const name = extensionPackages[0].name;
  const manifest = {
    dependencies: { [name]: 'workspace:*', zod: '4.4.3' },
    optionalDependencies: { [name]: 'workspace:^' },
    peerDependencies: { [name]: 'workspace:*' },
    devDependencies: { internal: 'workspace:*' },
  };
  const result = resolveRuntimeDependencies(
    manifest,
    new Map([[name, { version: '0.2.0' }]]),
  );
  for (const field of [
    'dependencies',
    'optionalDependencies',
    'peerDependencies',
  ])
    assert.equal(result[field][name], '0.2.0');
  assert.equal(result.dependencies.zod, '4.4.3');
  assert.equal(result.devDependencies.internal, 'workspace:*');
  assert.equal(manifest.dependencies[name], 'workspace:*');
  for (const dependency of [
    undefined,
    { private: true, version: '0.1.0' },
    { version: 'workspace:*' },
  ]) {
    assert.throws(
      () => resolveRuntimeDependencies(manifest, new Map([[name, dependency]])),
      /workspace runtime dependency/,
    );
  }
  assert.throws(
    () =>
      resolveRuntimeDependencies(
        { dependencies: { internal: 'file:../internal' } },
        new Map(),
      ),
    /Non-registry/,
  );
});

test('confirms the newest reachable helper version, with bounded propagation retry', async () => {
  const helper = extensionPackages[0];
  let attempts = 0;
  const delays = [];
  const providers = {
    reachableTags: async () => [
      `${helper.name}-v0.3.0`,
      `${helper.name}-v0.1.0`,
    ],
    npmVersion: async (name) => {
      assert.equal(name, `${helper.name}@0.3.0`);
      if (++attempts < 3) throw new Error('not yet visible');
      return '0.3.0';
    },
    sleep: async (ms) => {
      delays.push(ms);
    },
  };
  assert.equal(await publishedHelperVersion('/fixture', providers), '0.3.0');
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [1000, 3000]);
  attempts = 0;
  await assert.rejects(
    publishedHelperVersion('/fixture', {
      ...providers,
      npmVersion: async () => {
        attempts++;
        throw new Error('absent');
      },
    }),
    /refusing to prepare/,
  );
  assert.equal(attempts, 3);
  await assert.rejects(
    publishedHelperVersion('/fixture', {
      ...providers,
      reachableTags: async () => [],
    }),
    /missing reachable/,
  );
});

test('manifest preparation uses published helper metadata rather than stale source versions', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const manifest = JSON.parse(
    await readFile(
      new URL(
        '../packages/mcp-extension-push-notifications/package.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const helper = extensionPackages[0];
  const prepared = await prepareManifest(manifest, root, {
    reachableTags: async () => [`${helper.name}-v0.9.0`],
    npmVersion: async () => '0.9.0',
  });
  assert.equal(prepared.dependencies[helper.name], '0.9.0');
  assert.equal(manifest.dependencies[helper.name], 'workspace:*');
});

test('workflow validates before publishing and releases the helper before consumers and machine', async () => {
  const workflow = await readFile(
    new URL('../.github/workflows/release.yml', import.meta.url),
    'utf8',
  );
  const order = [
    'pnpm install --frozen-lockfile',
    'node scripts/verify-mcp-extension-packages.mjs',
    'node scripts/mcp-extension-release-plugin.mjs --preflight',
    '--extends ./packages/mcp-proxy-sdk/.releaserc.js',
    ...extensionPackages.map(
      ({ packageRoot }) => `--extends ./${packageRoot}/.releaserc.js`,
    ),
    '--extends ./mcp-servers/klex-machine/.releaserc.js',
    '--extends ./packages/agent-admin-api/.releaserc.js',
  ];
  let previous = -1;
  for (const step of order) {
    const position = workflow.indexOf(step);
    assert.ok(
      position > previous,
      `Missing or misordered release step: ${step}`,
    );
    previous = position;
  }
  assert.equal(
    (workflow.match(/npm_config_verify_deps_before_run: "false"/g) ?? [])
      .length,
    6,
  );
  assert.ok(workflow.includes('id-token: write'));
  assert.ok(workflow.includes('cancel-in-progress: false'));
  assert.ok(!workflow.includes('NPM_TOKEN'));
});
