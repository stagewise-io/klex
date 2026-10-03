import { readFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';

import { transform } from 'esbuild';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    {
      // Use the same esbuild text loader as the production bundle.
      name: 'klex-markdown-text',
      async load(id) {
        const path = id.split('?')[0]!;
        if (!path.endsWith('.md')) return null;
        const text = await readFile(path, 'utf8');
        return (await transform(text, { loader: 'text', format: 'esm' })).code;
      },
    },
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src/', import.meta.url)),
    },
  },
  test: {
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/index.ts',
        'src/**/test-helpers.ts',
      ],
    },
  },
});
