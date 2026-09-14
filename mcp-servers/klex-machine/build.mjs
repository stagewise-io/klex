import { chmod, rm } from 'node:fs/promises';

import { build } from 'esbuild';

await rm('dist', { force: true, recursive: true });
await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  outfile: 'dist/index.js',
  external: ['node-pty'],
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __klexCreateRequire } from 'node:module';\nconst require = __klexCreateRequire(import.meta.url);",
  },
  sourcemap: true,
  legalComments: 'eof',
});
await chmod('dist/index.js', 0o755);

console.log('Build complete: dist/index.js');
