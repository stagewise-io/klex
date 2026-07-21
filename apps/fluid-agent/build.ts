import type { BuildOptions } from 'esbuild';
import * as esbuild from 'esbuild';

const isWatch = process.argv.includes('--watch');
const isSea = process.argv.includes('--sea');

const sharedOptions: BuildOptions = {
  tsconfig: 'tsconfig.json',
  alias: {
    '@': './src',
  },
  bundle: true,
  platform: 'node',
  target: 'node22',
  sourcemap: false,
  minify: true,
  treeShaking: true,
  keepNames: false,
  loader: {
    '.md': 'text',
  },
};

const mainBuildOptions: BuildOptions = {
  ...sharedOptions,
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.js',
  // SEA embeds the blob as CJS — must output CJS for executable builds.
  // Normal dev/build uses ESM.
  format: isSea ? 'cjs' : 'esm',
};

const workerBuildOptions: BuildOptions = {
  ...sharedOptions,
  entryPoints: ['src/toolbox/worker-entry.ts'],
  outfile: 'dist/toolbox-worker.js',
  format: 'esm',
};

if (isWatch) {
  const [mainContext, workerContext] = await Promise.all([
    esbuild.context(mainBuildOptions),
    esbuild.context(workerBuildOptions),
  ]);
  await Promise.all([mainContext.watch(), workerContext.watch()]);
  console.log('Watching for changes...');
} else {
  await Promise.all([
    esbuild.build(mainBuildOptions),
    esbuild.build(workerBuildOptions),
  ]);
  console.log(
    `Build complete → dist/main.js (${isSea ? 'CJS/SEA' : 'ESM'}) + dist/toolbox-worker.js`,
  );
}
