import { createScopedReleaseConfig } from '../../scripts/scoped-release-config.mjs';

export default createScopedReleaseConfig({
  packageRoot: 'packages/mcp-proxy-sdk',
  scope: 'mcp-proxy-sdk',
  tagFormat: '@klex/mcp-proxy-sdk-v${version}',
});
