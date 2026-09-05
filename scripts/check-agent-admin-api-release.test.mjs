import assert from 'node:assert/strict';
import test from 'node:test';

import { commitsDeclareScope } from './check-agent-admin-api-release.mjs';

test('accepts a non-empty commit with the release scope', () => {
  assert.equal(
    commitsDeclareScope(
      [
        {
          changedFiles: ['apps/klex/src/admin-api/server.ts'],
          message: 'feat(klex,agent-admin-api): add route',
        },
      ],
      'agent-admin-api',
    ),
    true,
  );
});

test('rejects empty and incorrectly scoped release commits', () => {
  assert.equal(
    commitsDeclareScope(
      [
        {
          changedFiles: ['apps/klex/src/admin-api/server.ts'],
          message: 'feat(klex): add route',
        },
        {
          changedFiles: [],
          message: 'feat(agent-admin-api): trigger release',
        },
      ],
      'agent-admin-api',
    ),
    false,
  );
});
