import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

import { staticMascots } from './apps/website/static-mascot-plugin.ts';

export default defineConfig({
  plugins: [staticMascots()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./apps/website/src', import.meta.url)),
    },
  },
});
