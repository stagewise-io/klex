import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeCommits, commitHasScope } from './release-plugin.mjs';

const logger = { log() {} };

async function analyze(message) {
  return analyzeCommits(
    { scope: 'agent-admin-api' },
    {
      commits: [{ hash: 'test-commit', message }],
      cwd: process.cwd(),
      logger,
    },
  );
}

test('releases a patch for any agent-admin-api scoped commit', async () => {
  assert.equal(
    await analyze('chore(agent-admin-api): refresh metadata'),
    'patch',
  );
  assert.equal(
    await analyze('fix(agent-admin-api): repair declarations'),
    'patch',
  );
});

test('releases a minor for an agent-admin-api feature', async () => {
  assert.equal(
    await analyze('feat(agent-admin-api): add route types'),
    'minor',
  );
});

test('recognizes agent-admin-api in a comma-separated scope list', async () => {
  assert.equal(
    await analyze('feat(klex,agent-admin-api): add route types'),
    'minor',
  );
  assert.equal(
    commitHasScope(
      'fix(agent-admin-api,klex): repair route types',
      'agent-admin-api',
    ),
    true,
  );
  assert.equal(
    commitHasScope(
      'fix(klex,agent-admin-api-client): repair client',
      'agent-admin-api',
    ),
    false,
  );
});

test('releases a major for an agent-admin-api breaking change', async () => {
  assert.equal(
    await analyze(
      'feat(agent-admin-api): replace contract\n\nBREAKING CHANGE: consumers must migrate',
    ),
    'major',
  );
});

test('does not release for another package scope', async () => {
  assert.equal(await analyze('fix(mcp-proxy): repair transport'), null);
});
