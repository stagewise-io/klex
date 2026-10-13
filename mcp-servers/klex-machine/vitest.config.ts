import { fileURLToPath, URL } from 'node:url';

import { defineConfig } from 'vitest/config';

// Mirror build.mjs so tests run from workspace sources without sibling builds.
const source = (path: string) =>
  fileURLToPath(new URL(`../../packages/${path}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@stagewise/mcp-extension-client': source(
        'mcp-extension-client/src/index.ts',
      ),
      '@stagewise/mcp-extension-push-notifications': source(
        'mcp-extension-push-notifications/src/index.ts',
      ),
    },
  },
  test: {},
});
