import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const isSea = process.argv.includes('--sea');

await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  format: isSea ? 'cjs' : 'esm',
  target: 'node22',
  outfile: 'dist/main.js',
  packages: isSea ? 'bundle' : 'external',
  alias: {
    '@': fileURLToPath(new URL('./src/', import.meta.url)),
  },
  sourcemap: !isSea,
  minify: isSea,
  legalComments: 'none',
});
