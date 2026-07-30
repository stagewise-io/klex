import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'dist/index.js',
  packages: 'external',
  alias: {
    '@stagewise/logger': fileURLToPath(
      new URL('../../packages/logger/src/index.ts', import.meta.url),
    ),
    '@stagewise/mcp-extension-push-notifications/server': fileURLToPath(
      new URL(
        '../../packages/mcp-extension-push-notifications/src/server/index.ts',
        import.meta.url,
      ),
    ),
  },
  sourcemap: true,
  legalComments: 'none',
});
