import assert from 'node:assert/strict';
import test from 'node:test';

import klexMachineConfig from '../../mcp-servers/klex-machine/.releaserc.js';
import {
  analyzeCommits,
  commitHasScope,
} from '../../scripts/scoped-release-plugin.mjs';
import mcpProxySdkConfig from '../mcp-proxy-sdk/.releaserc.js';
import agentAdminApiConfig from './.releaserc.js';

const logger = { log() {} };

async function analyze(message, scope = 'agent-admin-api') {
  return analyzeCommits(
    { scope },
    {
      commits: [{ hash: 'test-commit', message }],
      cwd: process.cwd(),
      logger,
    },
  );
}

function pluginOptions(config, pluginName) {
  const entry = config.plugins.find(
    (plugin) => Array.isArray(plugin) && plugin[0].endsWith(pluginName),
  );
  assert.ok(entry, `Missing ${pluginName} plugin`);
  return entry[1];
}

test('releases a patch for any matching scoped commit', async () => {
  assert.equal(
    await analyze('chore(agent-admin-api): refresh metadata'),
    'patch',
  );
  assert.equal(
    await analyze('fix(mcp-proxy-sdk): repair declarations', 'mcp-proxy-sdk'),
    'patch',
  );
});

test('releases a minor for a matching scoped feature', async () => {
  assert.equal(
    await analyze('feat(machine): add route types', 'machine'),
    'minor',
  );
});

test('recognizes an exact scope in a comma-separated scope list', async () => {
  assert.equal(
    await analyze('feat(klex,agent-admin-api): add route types'),
    'minor',
  );
  assert.equal(
    commitHasScope('fix(mcp-proxy-sdk,machine): repair transport', 'machine'),
    true,
  );
});

test('rejects lookalike, unrelated, and unscoped commits', async () => {
  assert.equal(
    commitHasScope(
      'fix(klex,agent-admin-api-client): repair client',
      'agent-admin-api',
    ),
    false,
  );
  assert.equal(
    commitHasScope('fix(mcp-proxy-sdk-extra): repair proxy', 'mcp-proxy-sdk'),
    false,
  );
  assert.equal(await analyze('fix(mcp-proxy): repair transport'), null);
  assert.equal(await analyze('fix: repair transport'), null);
});

test('releases a major for a matching scoped breaking change', async () => {
  assert.equal(
    await analyze(
      'feat(agent-admin-api): replace contract\n\nBREAKING CHANGE: consumers must migrate',
    ),
    'major',
  );
});

test('configures independent package roots, scopes, and tag formats', () => {
  const configurations = [
    {
      config: agentAdminApiConfig,
      packageRoot: 'packages/agent-admin-api',
      scope: 'agent-admin-api',
      tagFormat: `@klex/agent-admin-api-v\${version}`,
    },
    {
      config: mcpProxySdkConfig,
      packageRoot: 'packages/mcp-proxy-sdk',
      scope: 'mcp-proxy-sdk',
      tagFormat: `@klex/mcp-proxy-sdk-v\${version}`,
    },
    {
      config: klexMachineConfig,
      packageRoot: 'mcp-servers/klex-machine',
      scope: 'machine',
      tagFormat: `@klex/machine-v\${version}`,
    },
  ];

  assert.equal(
    new Set(configurations.map(({ tagFormat }) => tagFormat)).size,
    configurations.length,
  );
  for (const { config, packageRoot, scope, tagFormat } of configurations) {
    assert.deepEqual(config.branches, ['main']);
    assert.equal(config.tagFormat, tagFormat);
    assert.equal(
      pluginOptions(config, 'scoped-release-plugin.mjs').scope,
      scope,
    );
    assert.equal(
      pluginOptions(config, '@semantic-release/npm').pkgRoot,
      packageRoot,
    );
    assert.ok(config.plugins.includes('@semantic-release/github'));
  }
});
