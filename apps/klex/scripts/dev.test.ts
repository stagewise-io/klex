import { expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rm: vi.fn().mockResolvedValue(undefined),
  watch: vi.fn().mockResolvedValue(undefined),
  context: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({ rm: mocks.rm }));
vi.mock('esbuild', () => ({ context: mocks.context }));
vi.mock('../build', () => ({
  createBuildOptions: () => ({
    main: { entryPoints: ['src/main.ts'], plugins: [] },
  }),
}));

it('starts the dev watcher with only the application build configuration', async () => {
  mocks.context.mockResolvedValue({ watch: mocks.watch });
  const signals = ['SIGINT', 'SIGTERM'] as const;
  const existing = signals.map((signal) => new Set(process.listeners(signal)));
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    await import('./dev');
    expect(mocks.context).toHaveBeenCalledTimes(1);
    expect(mocks.context).toHaveBeenCalledWith({
      entryPoints: ['src/main.ts'],
      plugins: [expect.objectContaining({ name: 'dev-main' })],
    });
    expect(mocks.watch).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('Watching for changes...');
  } finally {
    log.mockRestore();
    for (const [index, signal] of signals.entries()) {
      for (const listener of process.listeners(signal)) {
        if (!existing[index]?.has(listener))
          process.removeListener(signal, listener);
      }
    }
  }
});
