import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const expectedExports = {
  './core': {
    types: './dist/core/index.d.ts',
    default: './dist/core/index.js',
  },
  './http': {
    types: './dist/http/index.d.ts',
    default: './dist/http/index.js',
  },
  './server': {
    types: './dist/server/index.d.ts',
    default: './dist/server/index.js',
  },
  './daemon/node': {
    types: './dist/daemon/node/index.d.ts',
    default: './dist/daemon/node/index.js',
  },
};

async function typescriptSources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return typescriptSources(path);
      return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')
        ? [path]
        : [];
    }),
  );
  return nested.flat();
}

describe('public SDK boundaries', () => {
  it('publishes only explicit runtime entry points', async () => {
    const manifest = JSON.parse(
      await readFile(resolve(packageRoot, 'package.json'), 'utf8'),
    ) as { exports: unknown };

    expect(manifest.exports).toEqual(expectedExports);
  });

  it.each(['core', 'http'])(
    '%s stays free of Node-only imports',
    async (name) => {
      const files = await typescriptSources(resolve(packageRoot, 'src', name));
      const source = (
        await Promise.all(files.map((file) => readFile(file, 'utf8')))
      ).join('\n');

      expect(source).not.toMatch(/from ['"]node:/);
      expect(source).not.toMatch(/from ['"]ws['"]/);
      expect(source).not.toContain("from '@modelcontextprotocol/node'");
    },
  );
});
