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
    '@stagewise/mcp-extension-fluid-events/server': fileURLToPath(
      new URL(
        '../../packages/mcp-extension-fluid-events/src/server/index.ts',
        import.meta.url,
      ),
    ),
  },
  sourcemap: true,
  legalComments: 'none',
});
