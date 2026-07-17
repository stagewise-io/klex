import type { BuildOptions } from 'esbuild';
import * as esbuild from 'esbuild';

const isWatch = process.argv.includes('--watch');
const isSea = process.argv.includes('--sea');

const buildOptions: BuildOptions = {
  entryPoints: ['src/main.ts'],
  bundle: true,
  outfile: 'dist/main.js',
  // SEA embeds the blob as CJS — must output CJS for executable builds.
  // Normal dev/build uses ESM.
  format: isSea ? 'cjs' : 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: false,
  minify: true,
  treeShaking: true,
  keepNames: false,
};

if (isWatch) {
  const context = await esbuild.context(buildOptions);
  await context.watch();
  console.log('Watching for changes...');
} else {
  await esbuild.build(buildOptions);
  console.log(`Build complete → dist/main.js (${isSea ? 'CJS/SEA' : 'ESM'})`);
}
