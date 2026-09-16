import { chmod, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import { build } from 'esbuild';

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
  external: ['node-pty'],
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __klexCreateRequire } from 'node:module';\nconst require = __klexCreateRequire(import.meta.url);",
  },
  sourcemap: true,
  legalComments: 'eof',
});
if (process.platform !== 'win32') await chmod(outputFile, 0o755);

console.log('Build complete: dist/index.js');
