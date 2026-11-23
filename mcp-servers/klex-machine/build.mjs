import { chmod, copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { build } from 'esbuild';

import { buildMacosHelper } from './native/macos/build.mjs';

const packageRoot = import.meta.dirname;
const outputFile = resolve(packageRoot, 'dist/index.js');
await rm(resolve(packageRoot, 'dist'), { force: true, recursive: true });
await build({
  entryPoints: [resolve(packageRoot, 'src/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  outfile: outputFile,
  // dbus-next loads these only for transports and bus discovery klex-machine
  // never uses; it always connects to an explicit unix:socket address.
  external: ['node-pty', 'usocket', 'x11'],
  alias: {
    '@stagewise/mcp-extension-client': resolve(
      packageRoot,
      '../../packages/mcp-extension-client/src/index.ts',
    ),
    '@stagewise/mcp-extension-push-notifications/server': resolve(
      packageRoot,
      '../../packages/mcp-extension-push-notifications/src/server/index.ts',
    ),
    '@stagewise/mcp-extension-push-notifications': resolve(
      packageRoot,
      '../../packages/mcp-extension-push-notifications/src/index.ts',
    ),
  },
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __klexCreateRequire } from 'node:module';\nconst require = __klexCreateRequire(import.meta.url);",
  },
  sourcemap: true,
  legalComments: 'eof',
});
if (process.platform !== 'win32') await chmod(outputFile, 0o755);

// The macOS desktop helper is Swift and builds only on macOS. Other hosts,
// such as the Linux release job, copy one built on a macOS runner.
const macosHelper = resolve(packageRoot, 'dist/macos/klex-desktop-helper');
const prebuiltMacosHelper = process.env.KLEX_MACHINE_MACOS_HELPER_PREBUILT;
if (prebuiltMacosHelper) {
  await mkdir(dirname(macosHelper), { recursive: true });
  await copyFile(resolve(prebuiltMacosHelper), macosHelper);
  await chmod(macosHelper, 0o755);
  console.log('Copied prebuilt dist/macos/klex-desktop-helper');
} else if (process.platform === 'darwin') {
  await buildMacosHelper(macosHelper);
  console.log('Built dist/macos/klex-desktop-helper');
}

console.log('Build complete: dist/index.js');
