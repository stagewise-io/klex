import { createScopedReleaseConfig } from '../../scripts/scoped-release-config.mjs';

export default createScopedReleaseConfig({
  packageRoot: 'packages/mcp-extension-client',
  scope: 'mcp-extension-client',
  tagFormat: `@stagewise/mcp-extension-client-v\${version}`,
  mcpExtension: true,
});
