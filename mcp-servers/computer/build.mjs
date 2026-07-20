import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'dist/index.js',
  packages: 'external',
  sourcemap: true,
  legalComments: 'none',
});

console.log('Build complete: dist/index.js');
