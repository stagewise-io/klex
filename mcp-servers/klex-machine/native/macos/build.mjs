import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SOURCE = fileURLToPath(
  new URL('./klex-desktop-helper.swift', import.meta.url),
);
// Node 24, the oldest runtime klex-machine supports, needs macOS 13.5.
const MINIMUM_MACOS = '13.5';
const ARCHITECTURES = ['arm64', 'x86_64'];

/**
 * Builds the universal (arm64 and x86_64), ad-hoc signed desktop helper.
 * Needs macOS with Xcode or the Command Line Tools.
 */
export async function buildMacosHelper(output) {
  if (process.platform !== 'darwin') {
    throw new Error('The macOS desktop helper can only be built on macOS');
  }
  const work = await mkdtemp(join(tmpdir(), 'klex-desktop-helper-'));
  try {
    const slices = [];
    for (const architecture of ARCHITECTURES) {
      const slice = join(work, architecture);
      await run('xcrun', [
        'swiftc',
        '-swift-version',
        '5',
        '-O',
        '-target',
        `${architecture}-apple-macos${MINIMUM_MACOS}`,
        SOURCE,
        '-o',
        slice,
      ]);
      slices.push(slice);
    }
    await mkdir(dirname(output), { recursive: true });
    await run('xcrun', ['lipo', '-create', '-output', output, ...slices]);
    await run('codesign', ['--force', '--sign', '-', output]);
  } finally {
    await rm(work, { force: true, recursive: true });
  }
}

function run(file, args) {
  return new Promise((resolvePromise, reject) => {
    execFile(
      file,
      args,
      { maxBuffer: 16 * 1024 * 1024 },
      (error, _stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `${file} ${args.join(' ')} failed:\n${stderr || error.message}`,
            ),
          );
          return;
        }
        if (stderr.trim()) process.stderr.write(stderr);
        resolvePromise();
      },
    );
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  const output = process.argv[2];
  if (!output) {
    console.error('usage: node build.mjs <output path>');
    process.exit(2);
  }
  await buildMacosHelper(resolve(output));
  console.log(`Built ${resolve(output)}`);
}
