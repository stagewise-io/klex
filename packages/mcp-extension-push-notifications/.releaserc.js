import { createScopedReleaseConfig } from '../../scripts/scoped-release-config.mjs';

export default createScopedReleaseConfig({
  packageRoot: 'packages/mcp-extension-push-notifications',
  scope: 'mcp-extension-push-notifications',
  tagFormat: `@stagewise/mcp-extension-push-notifications-v\${version}`,
  mcpExtension: true,
});
