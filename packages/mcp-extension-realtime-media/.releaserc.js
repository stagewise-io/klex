import { createScopedReleaseConfig } from '../../scripts/scoped-release-config.mjs';

export default createScopedReleaseConfig({
  packageRoot: 'packages/mcp-extension-realtime-media',
  scope: 'mcp-extension-realtime-media',
  tagFormat: `@stagewise/mcp-extension-realtime-media-v\${version}`,
  mcpExtension: true,
});
