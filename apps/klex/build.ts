import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { BuildOptions } from 'esbuild';
import * as esbuild from 'esbuild';

import { resolveApplicationVersion } from '@/release';

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

/**
 * Virtualizes native packages (sharp, ffmpeg-static, @ffprobe-installer/ffprobe,
 * libsql) so they
 * load from the on-disk node_modules/ beside the SEA executable at runtime.
 *
 * The SEA embedder's require() only handles built-in modules — externalized
 * npm packages fail with ERR_UNKNOWN_BUILTIN_MODULE. This plugin replaces
 * imports of these packages with shim modules that use
 * createRequire(process.execPath) to create a proper Node.js require that
 * resolves from the executable's directory.
 *
 * The actual packages (JS + native binaries) are copied to dist/node_modules/
 * during packaging (see package-exe.ts → copyNativeAssets).
 */
const nativeShimPlugin: esbuild.Plugin = {
  name: 'native-shim',
  setup(build) {
    build.onResolve(
      {
        filter: /^(sharp|ffmpeg-static|@ffprobe-installer\/ffprobe|libsql)$/,
      },
      (args) => ({ path: args.path, namespace: 'native-shim' }),
    );
    build.onLoad({ filter: /.*/, namespace: 'native-shim' }, (args) => ({
      contents: `const{createRequire}=require("node:module");const r=createRequire(process.execPath);module.exports=r(${JSON.stringify(args.path)});`,
      loader: 'js',
    }));
  },
};

const applicationVersion = resolveApplicationVersion();

const sharedOptions: BuildOptions = {
  tsconfig: 'tsconfig.json',
  define: {
    __KLEX_VERSION__: JSON.stringify(applicationVersion),
  },
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
      // Bundle JS into the SEA blob. Native packages are loaded from copied
      // on-disk assets, while foreign LiveKit bindings remain unresolved.
      ...(isSea ? { plugins: [aliasPlugin, nativeShimPlugin] } : {}),
      external: isSea ? ['@livekit/rtc-ffi-bindings-*'] : undefined,
    },
    worker: {
      ...sharedOptions,
      entryPoints: [
        'src/session/chat/extensions/js-repl-sandbox/worker-entry.ts',
      ],
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
