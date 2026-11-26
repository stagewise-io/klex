import { defineConfig } from 'vitest/config';

// KLEX_MACHINE_IMPL picks one implementation; unset runs both. KLEX_MACHINE_BIN
// overrides the executable and therefore needs KLEX_MACHINE_IMPL as well.
const implementations = process.env.KLEX_MACHINE_IMPL
  ? [process.env.KLEX_MACHINE_IMPL]
  : ['ts', 'rust'];
if (process.env.KLEX_MACHINE_BIN && !process.env.KLEX_MACHINE_IMPL)
  throw new Error('KLEX_MACHINE_BIN requires KLEX_MACHINE_IMPL');

export default defineConfig({
  test: {
    projects: implementations.map((implementation) => ({
      extends: true,
      test: {
        name: implementation,
        env: { KLEX_MACHINE_IMPL: implementation },
      },
    })),
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
