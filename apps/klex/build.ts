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
 * libsql, and platform-specific libsql packages) so they load from the on-disk
 * node_modules/ beside the SEA executable at runtime.
 *
 * The SEA embedder cannot bundle native npm modules. This plugin replaces
 * imports of these packages with ESM shim modules that use createRequire(process.execPath)
 * to resolve the on-disk packages beside the executable.
 *
 * The actual packages (JS + native binaries) are copied to dist/node_modules/
 * during packaging (see package-exe.ts → copyNativeAssets).
 */
const nativeShimPlugin: esbuild.Plugin = {
  name: 'native-shim',
  setup(build) {
    build.onResolve(
      {
        filter:
          /^(sharp|ffmpeg-static|@ffprobe-installer\/ffprobe|ffprobe-static|libsql|@libsql\/(darwin|linux|win32)-)/,
      },
      (args) => ({ path: args.path, namespace: 'native-shim' }),
    );
    build.onLoad({ filter: /.*/, namespace: 'native-shim' }, (args) => ({
      contents: `import{createRequire}from"node:module";const r=createRequire(process.execPath);const m=r(${JSON.stringify(args.path)});export default m;export const path=m.path;`,
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
  target: 'node26',
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
      outfile: isSea ? 'dist/main.mjs' : 'dist/main.js',
      // SEA supports ESM bundles via mainFormat: module.
      format: 'esm',
      // Normal Node builds resolve dependencies from node_modules. Bundling them
      // into ESM breaks packages that use runtime CommonJS requires.
      packages: isSea ? 'bundle' : 'external',
      // Bundle JS into the SEA blob. Native packages are loaded from copied
      // on-disk assets, while foreign LiveKit bindings remain unresolved.
      ...(isSea ? { plugins: [aliasPlugin, nativeShimPlugin] } : {}),
      ...(isSea
        ? {
            banner: {
              js: 'import{createRequire}from"node:module";const require=createRequire(process.execPath);',
            },
            // fluent-ffmpeg is bundled, but its legacy CommonJS source refers
            // to __dirname for its preset directory. Resolve that reference
            // to the SEA entry directory; package-exe.ts copies the presets
            // there as a small, explicit runtime asset.
            define: { __dirname: 'import.meta.dirname' },
          }
        : {}),
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
    `Build complete → ${isSea ? 'dist/main.mjs (ESM/SEA)' : 'dist/main.js (ESM)'} + dist/javascript-sandbox-worker.js`,
  );
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  await main();
}
