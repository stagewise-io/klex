import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'dist/main.js',
  packages: 'external',
  alias: {
    '@': fileURLToPath(new URL('./src/', import.meta.url)),
  },
  sourcemap: true,
  legalComments: 'none',
});
