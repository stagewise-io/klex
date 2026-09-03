import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { path as ffprobeStaticPath } from '@ffprobe-installer/ffprobe';
import { createClient } from '@libsql/client';
import ffmpegStaticPath from 'ffmpeg-static';

/**
 * Native dependency load probe.
 *
 * The packaging smoke test can only check that native assets exist on disk.
 * Existence is not loadability: a `.node` addon with a broken @rpath, a missing
 * sibling library, an architecture mismatch or an unresolved glibc symbol passes
 * every `existsSync` check and still fails at `dlopen`.
 *
 * Two of our native dependencies are loaded lazily (sharp on first image,
 * LiveKit on first realtime session), so a broken addon does not surface at
 * startup — it surfaces in front of a user. sharp is worse still: its loader in
 * `image-input-optimizer/image-processing.ts` swallows the error and silently
 * degrades, so nothing crashes at all.
 *
 * This probe force-loads and minimally exercises every native dependency so
 * `dlopen` genuinely happens, and is invoked by `klex --verify-native` from
 * `scripts/smoke-exe.ts`. It deliberately does not reuse the production lazy
 * loaders, because those are built to tolerate failure.
 *
 * When adding a native dependency, add a probe here.
 * See .stagewise/skills/native-dependencies/SKILL.md
 *
 * Intentionally not re-exported from `@/release`: that barrel is imported by
 * `build.ts`, which must not pull native dependencies into the build step.
 * `main.ts` imports this module directly.
 */
export interface NativeProbeResult {
  readonly detail?: string;
  readonly name: string;
  readonly ok: boolean;
}

async function probe(
  name: string,
  run: () => Promise<void> | void,
): Promise<NativeProbeResult> {
  try {
    await run();
    return { name, ok: true };
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    const detail =
      cause === undefined
        ? (error as Error).message
        : `${(error as Error).message} (cause: ${String(cause)})`;
    return { detail, name, ok: false };
  }
}

/**
 * Loads every native dependency and returns one result per module.
 * Collects all failures rather than stopping at the first.
 */
export async function verifyNativeDependencies(): Promise<
  readonly NativeProbeResult[]
> {
  return [
    // Mirrors the production require() in image-processing.ts, but without the
    // try/catch that turns a load failure into a silent no-op. Encoding a real
    // image forces libvips to initialise, not just the addon to link.
    await probe('sharp', async () => {
      type SharpFn = typeof import('sharp')['default'];
      // Mirrors the interop unwrap in image-processing.ts: the SEA shim is ESM,
      // so require() yields a namespace object here, not the callable.
      const loaded = require('sharp') as SharpFn | { default: SharpFn };
      const sharp = typeof loaded === 'function' ? loaded : loaded.default;
      if (typeof sharp !== 'function') {
        throw new Error(
          `sharp loaded but is not callable (got ${typeof loaded})`,
        );
      }
      await sharp({
        create: {
          background: { b: 0, g: 0, r: 0 },
          channels: 3,
          height: 1,
          width: 1,
        },
      })
        .png()
        .toBuffer();
    }),

    // An in-memory database still loads the @libsql/<target> addon through
    // @neon-rs/load, and the query forces it to actually execute.
    await probe('libsql', async () => {
      const client = createClient({ url: ':memory:' });
      try {
        await client.execute('select 1');
      } finally {
        client.close();
      }
    }),

    // ffmpeg has no cheap version probe that is safe on every platform, so
    // assert the binary is present; audio-processing.ts already throws at module
    // load if it is missing or unresolvable.
    await probe('ffmpeg-static', () => {
      if (ffmpegStaticPath === null || !existsSync(ffmpegStaticPath)) {
        throw new Error(`ffmpeg binary not found at ${ffmpegStaticPath}`);
      }
    }),

    // ffprobe is a plain executable, so executing it is the real test that it
    // was copied with its permissions and dynamic libraries intact.
    await probe('ffprobe', () => {
      execFileSync(ffprobeStaticPath, ['-version'], { stdio: 'ignore' });
    }),

    // Uses the production loader: it already throws with a cause on failure and
    // owns the platform-specific binding resolution.
    await probe('@livekit/rtc-node', async () => {
      const { loadLiveKitSdk } = await import(
        '@/media-transport/livekit-room/sdk-loader'
      );
      const sdk = await loadLiveKitSdk();
      await sdk.dispose();
    }),
  ];
}

/**
 * Runs every probe, writes one line per module to stdout and returns the
 * process exit code (0 when all probes pass, 1 otherwise).
 */
export async function runNativeVerification(): Promise<number> {
  const results = await verifyNativeDependencies();
  for (const result of results) {
    const status = result.ok ? 'ok' : 'FAIL';
    const suffix = result.detail === undefined ? '' : ` — ${result.detail}`;
    process.stdout.write(`native ${status}: ${result.name}${suffix}\n`);
  }
  const failed = results.filter((result) => !result.ok);
  if (failed.length > 0) {
    process.stdout.write(
      `\n${failed.length} native dependency probe(s) failed. ` +
        'The packaged executable is missing or cannot load a native asset.\n' +
        'See .stagewise/skills/native-dependencies/SKILL.md\n',
    );
    return 1;
  }
  process.stdout.write(
    `\nAll ${results.length} native dependency probes passed.\n`,
  );
  return 0;
}
