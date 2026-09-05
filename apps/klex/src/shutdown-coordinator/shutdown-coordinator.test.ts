import { describe, expect, it, vi } from 'vitest';

import { createShutdownCoordinator } from './shutdown-coordinator';

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('shutdown coordinator', () => {
  it('deduplicates exit and restart requests', async () => {
    const exit = vi.fn();
    const cleanup = vi.fn(async () => undefined);
    const coordinator = createShutdownCoordinator({
      cleanup,
      closeUi: vi.fn(),
      exit,
      onRestartError: vi.fn(),
    });
    coordinator.requestExit();
    coordinator.requestExit();
    coordinator.requestRestart({
      arguments: [],
      cwd: process.cwd(),
      environment: process.env,
      launcher: process.execPath,
    });
    await tick();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
  });

  it('waits for cleanup and replacement completion before exiting', async () => {
    let finishCleanup: (() => void) | undefined;
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    let finishReplacement: ((code: number) => void) | undefined;
    const replacement = new Promise<number>((resolve) => {
      finishReplacement = resolve;
    });
    const restartProcess = vi.fn(() => replacement);
    const exit = vi.fn();
    const coordinator = createShutdownCoordinator({
      cleanup: () => cleanup,
      closeUi: vi.fn(),
      exit,
      onRestartError: vi.fn(),
      restartProcess,
      timeoutMs: 1000,
    });
    coordinator.requestRestart({
      arguments: ['--version'],
      cwd: process.cwd(),
      environment: process.env,
      launcher: process.execPath,
    });
    await tick();
    expect(exit).not.toHaveBeenCalled();
    finishCleanup?.();
    await tick();
    expect(restartProcess).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
    finishReplacement?.(0);
    await tick();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('does not restart when cleanup times out', async () => {
    const exit = vi.fn();
    const onRestartError = vi.fn();
    const restartProcess = vi.fn(async () => 0);
    const coordinator = createShutdownCoordinator({
      cleanup: () => new Promise(() => {}),
      closeUi: vi.fn(),
      exit,
      onRestartError,
      restartProcess,
      timeoutMs: 5,
    });
    coordinator.requestRestart({
      arguments: [],
      cwd: process.cwd(),
      environment: process.env,
      launcher: process.execPath,
    });
    await tick();
    expect(restartProcess).not.toHaveBeenCalled();
    expect(onRestartError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Timed out while releasing application resources',
      }),
    );
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('reports replacement failure and exits unsuccessfully', async () => {
    const exit = vi.fn();
    const onRestartError = vi.fn();
    const coordinator = createShutdownCoordinator({
      cleanup: async () => undefined,
      closeUi: vi.fn(),
      exit,
      onRestartError,
      restartProcess: async () => {
        throw new Error('replacement failed');
      },
    });
    coordinator.requestRestart({
      arguments: [],
      cwd: process.cwd(),
      environment: process.env,
      launcher: '/definitely/missing/klex',
    });
    await tick();
    expect(onRestartError).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
  });
});
