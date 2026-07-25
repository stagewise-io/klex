import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { BuildOptions } from 'esbuild';
import * as esbuild from 'esbuild';

/**
 * esbuild plugin that resolves the `@/` import alias to `./src/`,
 * matching the tsconfig `paths` configuration.
 * Necessary because esbuild's `alias` option rejects keys containing `/`.
 * Delegates to esbuild's native resolver so directory → index.ts
 * and extension resolution work as expected.
 */
const aliasPlugin: esbuild.Plugin = {
  name: 'alias-at',
  setup(build) {
    build.onResolve({ filter: /^@\// }, async (args) => {
      const resolvedPath = path.resolve(
        import.meta.dirname,
        'src',
        args.path.slice(2),
      );
      return build.resolve(resolvedPath, {
        resolveDir: import.meta.dirname,
        importer: args.importer,
        kind: args.kind,
      });
    });
  },
};

const sharedOptions: BuildOptions = {
  tsconfig: 'tsconfig.json',
  plugins: [aliasPlugin],
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

export function createBuildOptions(isSea: boolean): {
  main: BuildOptions;
  worker: BuildOptions;
} {
  return {
    main: {
      ...sharedOptions,
      entryPoints: ['src/main.ts'],
      outfile: 'dist/main.js',
      // SEA embeds the blob as CJS — must output CJS for executable builds.
      // Normal dev/build uses ESM.
      format: isSea ? 'cjs' : 'esm',
      // Normal Node builds resolve dependencies from node_modules. Bundling them
      // into ESM breaks packages that use runtime CommonJS requires.
      packages: isSea ? 'bundle' : 'external',
    },
    worker: {
      ...sharedOptions,
      entryPoints: ['src/session/tools/javascript/worker-entry.ts'],
      outfile: 'dist/javascript-sandbox-worker.js',
      format: 'esm',
    },
  };
}

async function main(): Promise<void> {
  const isSea = process.argv.includes('--sea');
  const options = createBuildOptions(isSea);
  await Promise.all([
    esbuild.build(options.main),
    esbuild.build(options.worker),
  ]);
  console.log(
    `Build complete → dist/main.js (${isSea ? 'CJS/SEA' : 'ESM'}) + dist/javascript-sandbox-worker.js`,
  );
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  await main();
}
