import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

import { staticMascots } from './static-mascot-plugin.ts';

export default defineConfig({
  plugins: [staticMascots()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: { include: ['src/**/*.test.{ts,tsx}'], environment: 'node' },
});
