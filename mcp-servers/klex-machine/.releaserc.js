import { fileURLToPath } from 'node:url';

import { createScopedReleaseConfig } from '../../scripts/scoped-release-config.mjs';

const packageRoot = 'mcp-servers/klex-machine';

export default createScopedReleaseConfig({
  packageRoot,
  scope: 'machine',
  tagFormat: '@klex/machine-v${version}',
  beforeNpm: [
    [
      fileURLToPath(new URL('./npm/release-plugin.mjs', import.meta.url)),
      { pkgRoot: packageRoot },
    ],
  ],
});
