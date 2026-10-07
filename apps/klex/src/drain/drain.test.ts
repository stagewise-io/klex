import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RootLogger } from '@stagewise/logger';

import { createDrain, type DrainRequest } from './drain';

const logger = {
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  trace: vi.fn(),
  warn: vi.fn(),
};
const logging = { child: () => logger } as unknown as RootLogger;

const UPDATE: DrainRequest = {
  reason: 'update',
  timeoutMs: 10_000,
  pauseWhileLeased: true,
};
const TERMINATION: DrainRequest = {
  reason: 'termination',
  timeoutMs: 10_000,
  pauseWhileLeased: false,
};

function createHarness() {
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
  const onBegin = vi.fn();
  const drain = createDrain({
    logging,
    sessionHost,
    godMessages,
    mcp,
    pollIntervalMs: 1_000,
    onBegin,
  });
  return { drain, godMessages, host, mcp, sessionHost, onBegin };
}

describe('Drain', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('drains immediately when quiescent and flushes acknowledgements', async () => {
    const harness = createHarness();
    harness.host.quiescent = true;

    await expect(harness.drain.drain(UPDATE)).resolves.toBe('drained');
    expect(harness.sessionHost.beginDrain).toHaveBeenCalledTimes(1);
    expect(harness.godMessages.beginDrain).toHaveBeenCalledTimes(1);
    expect(harness.mcp.pausePushDelivery).toHaveBeenCalledTimes(1);
    expect(harness.mcp.acknowledgeDeliveredEvents).toHaveBeenCalledTimes(1);
  });

  it('notifies readiness synchronously, once, for concurrent drains', async () => {
    const harness = createHarness();
    const first = harness.drain.drain(UPDATE);
    expect(harness.onBegin).toHaveBeenCalledTimes(1);
    const second = harness.drain.drain(TERMINATION);
    expect(harness.onBegin).toHaveBeenCalledTimes(1);
    harness.host.quiescent = true;
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all([first, second]);
  });

  it('waits for the god session as well as the default session', async () => {
    const harness = createHarness();
    harness.host.quiescent = true;
    harness.host.godQuiescent = false;
    const drain = harness.drain.drain(UPDATE);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(harness.mcp.acknowledgeDeliveredEvents).not.toHaveBeenCalled();

    harness.host.godQuiescent = true;
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(drain).resolves.toBe('drained');
  });

  it('waits while busy and drains once quiescent', async () => {
    const harness = createHarness();
    const drain = harness.drain.drain(UPDATE);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(harness.mcp.acknowledgeDeliveredEvents).not.toHaveBeenCalled();

    harness.host.quiescent = true;
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(drain).resolves.toBe('drained');
    expect(harness.mcp.acknowledgeDeliveredEvents).toHaveBeenCalledTimes(1);
  });

  it('times out after the budget without acknowledging', async () => {
    const harness = createHarness();
    const drain = harness.drain.drain(UPDATE);

    await vi.advanceTimersByTimeAsync(10_000);
    await expect(drain).resolves.toBe('timed-out');
    expect(harness.mcp.acknowledgeDeliveredEvents).not.toHaveBeenCalled();
  });

  it('does not count leased time when pausing while leased', async () => {
    const harness = createHarness();
    harness.host.leased = true;
    let outcome: string | undefined;
    void harness.drain.drain(UPDATE).then((value) => {
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

  it('counts leased time as wall clock when not pausing', async () => {
    const harness = createHarness();
    harness.host.leased = true;
    const drain = harness.drain.drain(TERMINATION);

    await vi.advanceTimersByTimeAsync(10_000);
    await expect(drain).resolves.toBe('timed-out');
  });

  it('stops a budget that is not a multiple of the poll interval on time', async () => {
    const harness = createHarness();
    let outcome: string | undefined;
    void harness.drain
      .drain({ ...TERMINATION, timeoutMs: 1_500 })
      .then((value) => {
        outcome = value;
      });

    await vi.advanceTimersByTimeAsync(1_500);
    expect(outcome).toBe('timed-out');
  });

  it('times out at once with a zero budget', async () => {
    const harness = createHarness();
    await expect(
      harness.drain.drain({ ...TERMINATION, timeoutMs: 0 }),
    ).resolves.toBe('timed-out');
    expect(harness.sessionHost.beginDrain).toHaveBeenCalledTimes(1);
  });

  it('gives concurrent requests their own budgets and one shared stop', async () => {
    const harness = createHarness();
    harness.host.leased = true;
    let update: string | undefined;
    void harness.drain.drain(UPDATE).then((value) => {
      update = value;
    });
    const termination = harness.drain.drain({
      ...TERMINATION,
      timeoutMs: 3_000,
    });

    await vi.advanceTimersByTimeAsync(3_000);
    await expect(termination).resolves.toBe('timed-out');
    expect(update).toBeUndefined();
    expect(harness.sessionHost.beginDrain).toHaveBeenCalledTimes(1);
    expect(harness.mcp.pausePushDelivery).toHaveBeenCalledTimes(1);

    harness.host.quiescent = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(update).toBe('drained');
    expect(harness.mcp.acknowledgeDeliveredEvents).toHaveBeenCalledTimes(1);
  });

  it('shares the acknowledgement flush across requests', async () => {
    const harness = createHarness();
    harness.host.quiescent = true;

    await Promise.all([
      harness.drain.drain(UPDATE),
      harness.drain.drain(TERMINATION),
    ]);
    expect(harness.mcp.acknowledgeDeliveredEvents).toHaveBeenCalledTimes(1);
  });

  it('proceeds when the acknowledgement flush hangs', async () => {
    const harness = createHarness();
    harness.host.quiescent = true;
    harness.mcp.acknowledgeDeliveredEvents.mockReturnValue(
      new Promise<void>(() => undefined),
    );

    const drain = harness.drain.drain(UPDATE);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(drain).resolves.toBe('drained');
    expect(logger.warn).toHaveBeenCalled();
  });
});
