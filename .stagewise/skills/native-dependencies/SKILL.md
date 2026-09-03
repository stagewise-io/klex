---
name: native-dependencies
description: Rules for adding, packaging and verifying native or platform-specific dependencies in klex. Use when introducing a dependency that ships a .node addon or a prebuilt binary, or when editing build.ts, package-exe.ts, smoke-exe.ts or verify-native.ts.
---

# Native Dependencies

Applies to every klex dependency that ships a `.node` addon or a prebuilt executable
(currently `sharp`, `libsql`, `ffmpeg-static`, `@ffprobe-installer/ffprobe`,
`@livekit/rtc-node`).

The SEA embedder cannot bundle native modules. Each one must be virtualized at build
time, copied at packaging time, and proven loadable at verification time. Miss one
step and the failure appears in front of a user, not in CI.

## The four places that must agree

| File | Responsibility |
|------|----------------|
| `apps/klex/build.ts` | `nativeShimPlugin` filter regex — replaces the import with an ESM shim that resolves the package from on-disk `node_modules/` via `createRequire(process.execPath)`. |
| `apps/klex/scripts/package-exe.ts` | Copies the JS package, its runtime deps and the platform-specific payload into `dist/node_modules/`, plus `.node` files registered as SEA assets. |
| `apps/klex/src/release/verify-native.ts` | Force-loads and minimally exercises the dependency so `dlopen` actually happens. |
| `apps/klex/scripts/smoke-exe.ts` | Runs the packaged binary with `--verify-native`. |

**When adding a native dependency, update all four.** There is no automatic
discovery.

Omitting the **shim regex** fails loudly at build time: esbuild reports
`No loader is configured for ".node" files` and refuses to bundle. Omitting the **copy
step** is the dangerous one — the build succeeds, the import is virtualized, and the
package is simply absent at runtime. Only `--verify-native` catches that.

## Existence is not loadability

Never treat a file check as verification. A `.node` addon with a broken `@rpath`, a
missing sibling library, an architecture mismatch or an unresolved glibc symbol
passes every `existsSync` check and still fails at `dlopen`.

`--verify-native` therefore *uses* each dependency: encodes a 1×1 image, executes
`select 1`, runs `ffprobe -version`, constructs and disposes the LiveKit SDK.

## Lazy loaders must not be trusted as probes

`sharp` (first image) and LiveKit (first realtime session) load lazily, so a broken
addon never surfaces at startup. Worse, `getSharp()` in
`session/chat/extensions/image-input-optimizer/image-processing.ts` catches the load
error and silently degrades — nothing crashes, images just stop being optimized.

Rules:

- Probes in `verify-native.ts` must bypass any loader that tolerates failure.
- Do not "simplify" a probe into calling the normal application path.
- A loader may swallow errors only if a probe covers the same module.

## ESM shim interop

The shim emits an ESM module (`export default m`). esbuild therefore compiles a
`require('<shimmed-pkg>')` into a **namespace object** (`{ default, path }`), not the
package's callable export. Code that calls the result directly must unwrap it:

```ts
const loaded = require('sharp') as SharpFn | { default: SharpFn };
const sharp = typeof loaded === 'function' ? loaded : loaded.default;
```

Without the unwrap, `isSharpAvailable()` returns `true` while every `sharp(...)` call
throws `is not a function`. This regression shipped once and was only caught by
`--verify-native`.

## `klex --verify-native`

Dedicated startup path (`cli.ts` → `main.ts` → `runNativeVerification()`).

- Prints one `native ok:` / `native FAIL:` line per dependency.
- Collects **all** failures instead of stopping at the first.
- Exits `0` when every probe passes, `1` otherwise.

`verify-native.ts` is deliberately **not** re-exported from the `@/release` barrel:
`build.ts` imports that barrel and must not pull native dependencies into the build
step. `main.ts` imports the module directly. Keep it that way.

## CI gate

`.github/workflows/ci.yml` runs `test:exe` on `pull_request` for `ubuntu-latest` and
`macos-latest`, pinned to Node `NODE_VERSION` (26.8.1). That job builds a real packaged
executable — unsigned, since signing stays `optional` without `KLEX_RELEASE_CHANNEL`, so
fork PRs need no secrets — and runs the smoke test, which includes `--verify-native`.
Native breakage fails the PR instead of surfacing at release or nightly.

Windows is release-only. It carries the most layout risk (libvips DLLs ship *inside*
`@img/sharp-win32-x64`, not a sibling package), so verify Windows manually when touching
sharp's packaging.

Do not weaken this to a build-only job, and do not skip the probe to make CI faster.

## Local verification

`pnpm test:exe` requires Node ≥ 26 (the SEA entry is ESM; older Node cannot execute
it and fails with `Cannot use import statement outside a module`).

To confirm the gate still detects breakage, remove a native payload from
`dist/node_modules/` and re-run `./dist/klex --verify-native` — it must exit `1`.
