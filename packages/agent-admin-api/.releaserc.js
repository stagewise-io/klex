import { createScopedReleaseConfig } from '../../scripts/scoped-release-config.mjs';

export default createScopedReleaseConfig({
  packageRoot: 'packages/agent-admin-api',
  scope: 'agent-admin-api',
  tagFormat: '@klex/agent-admin-api-v${version}',
});
