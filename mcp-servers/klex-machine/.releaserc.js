import { createScopedReleaseConfig } from '../../scripts/scoped-release-config.mjs';

export default createScopedReleaseConfig({
  packageRoot: 'mcp-servers/klex-machine',
  scope: 'klex-machine',
  tagFormat: 'klex-machine-v${version}',
});
