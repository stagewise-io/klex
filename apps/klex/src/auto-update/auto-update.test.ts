import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RootLogger } from '@stagewise/logger';

import type { DrainOutcome } from '@/drain';
import type { UpdateState } from '@/self-update';

import { createAutoUpdate } from './auto-update';

const logger = {
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  trace: vi.fn(),
  warn: vi.fn(),
};
const logging = { child: () => logger } as unknown as RootLogger;

function createHarness(initialState: UpdateState = { status: 'idle' }) {
  let state = initialState;
  const listeners = new Set<(state: UpdateState) => void>();
  const updateManager = {
    getState: vi.fn(() => state),
    subscribe: vi.fn((listener: (state: UpdateState) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    install: vi.fn(() => Promise.resolve()),
  };
  const drain = {
    drain: vi.fn(() => Promise.resolve<DrainOutcome>('drained')),
  };
  const autoUpdate = createAutoUpdate({
    logging,
    updateManager,
    drain,
    drainTimeoutMs: 10_000,
  });
  return {
    autoUpdate,
    drain,
    updateManager,
    emit(next: UpdateState) {
      state = next;
      for (const listener of listeners) listener(next);
    },
  };
}

describe('AutoUpdate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('installs when an update becomes available', () => {
    const harness = createHarness();
    harness.autoUpdate.start();
    expect(harness.updateManager.install).not.toHaveBeenCalled();

    harness.emit({ status: 'available', version: '1.2.3' });
    expect(harness.updateManager.install).toHaveBeenCalledTimes(1);

    harness.emit({ status: 'failed', message: 'boom', version: '1.2.3' });
    expect(harness.updateManager.install).toHaveBeenCalledTimes(1);
  });

  it('installs immediately when an update is already available', () => {
    const harness = createHarness({ status: 'available', version: '1.2.3' });
    harness.autoUpdate.start();
    harness.autoUpdate.start();
    expect(harness.updateManager.install).toHaveBeenCalledTimes(1);
  });

  it('stops installing after close', () => {
    const harness = createHarness();
    harness.autoUpdate.start();
    harness.autoUpdate.close();
    harness.emit({ status: 'available', version: '1.2.3' });
    expect(harness.updateManager.install).not.toHaveBeenCalled();
  });

  it('drains with the update budget and pauses during realtime calls', async () => {
    const harness = createHarness();

    await expect(harness.autoUpdate.drainForRestart()).resolves.toBe('drained');
    expect(harness.drain.drain).toHaveBeenCalledWith({
      reason: 'update',
      timeoutMs: 10_000,
      pauseWhileLeased: true,
    });
  });

  it('shares one drain across repeated calls', async () => {
    const harness = createHarness();

    const first = harness.autoUpdate.drainForRestart();
    const second = harness.autoUpdate.drainForRestart();
    expect(second).toBe(first);
    await first;
    expect(harness.drain.drain).toHaveBeenCalledTimes(1);
  });
});
