import { readFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    {
      // Mirrors the `'.md': 'text'` loader in build.ts so modules that
      // import prompt files load in tests without per-file mocks.
      name: 'klex-markdown-text',
      async load(id) {
        const path = id.split('?')[0]!;
        if (!path.endsWith('.md')) return null;
        const text = await readFile(path, 'utf8');
        return `export default ${JSON.stringify(text)};`;
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
