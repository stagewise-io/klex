import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RootLogger } from '@stagewise/logger';

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
  const host = { quiescent: false, leased: false, godQuiescent: true };
  const sessionHost = {
    isQuiescent: vi.fn(() => host.quiescent),
    isInteractionLeased: vi.fn(() => host.leased),
    beginDrain: vi.fn(),
  };
  const godMessages = {
    isQuiescent: vi.fn(() => host.godQuiescent),
    beginDrain: vi.fn(),
  };
  const mcp = {
    pausePushDelivery: vi.fn(),
    acknowledgeDeliveredEvents: vi.fn(() => Promise.resolve()),
  };
  const autoUpdate = createAutoUpdate({
    logging,
    updateManager,
    sessionHost,
    godMessages,
    mcp,
    drainTimeoutMs: 10_000,
    pollIntervalMs: 1_000,
  });
  return {
    autoUpdate,
    godMessages,
    host,
    mcp,
    sessionHost,
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

  it('drains immediately when quiescent and flushes acknowledgements', async () => {
    const harness = createHarness();
    harness.host.quiescent = true;

    await expect(harness.autoUpdate.drainForRestart()).resolves.toBe('drained');
    expect(harness.sessionHost.beginDrain).toHaveBeenCalledTimes(1);
    expect(harness.godMessages.beginDrain).toHaveBeenCalledTimes(1);
    expect(harness.mcp.pausePushDelivery).toHaveBeenCalledTimes(1);
    expect(harness.mcp.acknowledgeDeliveredEvents).toHaveBeenCalledTimes(1);
  });

  it('waits for the god session as well as the default session', async () => {
    const harness = createHarness();
    harness.host.quiescent = true;
    harness.host.godQuiescent = false;
    const drain = harness.autoUpdate.drainForRestart();

    await vi.advanceTimersByTimeAsync(3_000);
    expect(harness.mcp.acknowledgeDeliveredEvents).not.toHaveBeenCalled();

    harness.host.godQuiescent = true;
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(drain).resolves.toBe('drained');
  });

  it('waits while busy and drains once quiescent', async () => {
    const harness = createHarness();
    const drain = harness.autoUpdate.drainForRestart();

    await vi.advanceTimersByTimeAsync(3_000);
    expect(harness.mcp.acknowledgeDeliveredEvents).not.toHaveBeenCalled();

    harness.host.quiescent = true;
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(drain).resolves.toBe('drained');
    expect(harness.mcp.acknowledgeDeliveredEvents).toHaveBeenCalledTimes(1);
  });

  it('times out after the busy budget without acknowledging', async () => {
    const harness = createHarness();
    const drain = harness.autoUpdate.drainForRestart();

    await vi.advanceTimersByTimeAsync(10_000);
    await expect(drain).resolves.toBe('timed-out');
    expect(harness.mcp.acknowledgeDeliveredEvents).not.toHaveBeenCalled();
  });

  it('does not count leased time toward the deadline', async () => {
    const harness = createHarness();
    harness.host.leased = true;
    let outcome: string | undefined;
    void harness.autoUpdate.drainForRestart().then((value) => {
      outcome = value;
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(outcome).toBeUndefined();

    harness.host.leased = false;
    await vi.advanceTimersByTimeAsync(9_000);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(outcome).toBe('timed-out');
  });

  it('shares one drain across repeated calls', async () => {
    const harness = createHarness();
    harness.host.quiescent = true;

    const first = harness.autoUpdate.drainForRestart();
    const second = harness.autoUpdate.drainForRestart();
    expect(second).toBe(first);
    await first;
    expect(harness.sessionHost.beginDrain).toHaveBeenCalledTimes(1);
    expect(harness.mcp.pausePushDelivery).toHaveBeenCalledTimes(1);
  });

  it('proceeds when the acknowledgement flush hangs', async () => {
    const harness = createHarness();
    harness.host.quiescent = true;
    harness.mcp.acknowledgeDeliveredEvents.mockReturnValue(
      new Promise<void>(() => undefined),
    );

    const drain = harness.autoUpdate.drainForRestart();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(drain).resolves.toBe('drained');
    expect(logger.warn).toHaveBeenCalled();
  });
});
