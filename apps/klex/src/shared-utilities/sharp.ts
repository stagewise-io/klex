// Lazy-load sharp — it's a native addon. In SEA builds, sharp's JS is
// bundled into the blob and the native @img/sharp-* packages are copied to
// dist/node_modules/@img/ during packaging (see package-exe.ts).
// The build fails if native packages are missing, so this should always
// succeed. The lazy loading remains as a safety net for dev/non-SEA runs.
import { createRequire } from 'node:module';

export type SharpFn = typeof import('sharp')['default'];

let sharpModule: SharpFn | null = null;
let sharpChecked = false;

/** Returns sharp, or null when the native addon cannot be loaded. */
export function loadSharp(): SharpFn | null {
  if (sharpChecked) return sharpModule;
  sharpChecked = true;
  try {
    // Use require() for CJS compatibility in SEA builds.
    // In SEA builds `sharp` resolves to the ESM shim in build.ts, so esbuild
    // compiles this require() into a namespace object ({ default, path }) rather
    // than the callable sharp function. Unwrap `.default` or every sharp(...)
    // call throws "is not a function" while availability checks still report
    // true. Caught by `klex --verify-native`.
    const loaded = requireSharp();
    sharpModule =
      typeof loaded === 'function' ? loaded : (loaded.default ?? null);
  } catch {
    sharpModule = null;
  }
  return sharpModule;
}

function requireSharp(): SharpFn | { default: SharpFn } {
  try {
    return require('sharp') as SharpFn | { default: SharpFn };
  } catch (error) {
    // The non-SEA ESM build has no global require (esbuild's shim throws), so
    // resolve sharp from node_modules instead. SEA builds need the literal
    // require above for esbuild to bundle the shim.
    if (typeof import.meta.url !== 'string') throw error;
    return createRequire(import.meta.url)('sharp') as SharpFn;
  }
}
