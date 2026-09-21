import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getInteractionTelemetry,
  getRealtimeSessionCount,
  interactionLeaseAcquired,
  interactionLeaseReleased,
  interactionQueueOverflowed,
  interactionUpdateEnqueued,
  registerActivityStateProviders,
  setQueueOverflowRecorder,
  setTelemetryActivityEnabled,
} from './activity';

describe('activity telemetry state', () => {
  const providerCleanups: (() => void)[] = [];

  afterEach(() => {
    for (const cleanup of providerCleanups.splice(0)) cleanup();
    setQueueOverflowRecorder(null);
    setTelemetryActivityEnabled(false);
  });

  it('does no work while disabled and clears state on disable', () => {
    const recorder = vi.fn();
    setQueueOverflowRecorder(recorder);
    setTelemetryActivityEnabled(true);
    interactionLeaseAcquired();
    interactionUpdateEnqueued();
    interactionQueueOverflowed();
    expect(getInteractionTelemetry()).toMatchObject({
      activeLeases: 1,
      queuedUpdates: 1,
      queueOverflows: 1,
    });

    setTelemetryActivityEnabled(false);
    interactionLeaseReleased();
    interactionUpdateEnqueued();
    interactionQueueOverflowed();
    expect(getInteractionTelemetry()).toMatchObject({
      activeLeases: 0,
      queuedUpdates: 0,
      queueOverflows: 0,
    });
    expect(recorder).toHaveBeenCalledTimes(1);
  });

  it('rehydrates gauges from providers after re-enabling', () => {
    let primaryLease = 1;
    let primaryQueue = 4;
    let childLease = 0;
    let childQueue = 2;
    let realtime = 2;
    const unregisterPrimary = registerActivityStateProviders({
      getLeaseCount: () => primaryLease,
      getQueueDepth: () => primaryQueue,
    });
    providerCleanups.push(unregisterPrimary);
    const unregisterChild = registerActivityStateProviders({
      getLeaseCount: () => childLease,
      getQueueDepth: () => childQueue,
      getRealtimeSessionCount: () => realtime,
    });
    providerCleanups.push(unregisterChild);
    setTelemetryActivityEnabled(false);
    primaryLease = 3;
    primaryQueue = 7;
    childLease = 1;
    childQueue = 5;
    realtime = 5;
    setTelemetryActivityEnabled(true);
    expect(getInteractionTelemetry()).toMatchObject({
      activeLeases: 4,
      queuedUpdates: 12,
    });
    expect(getRealtimeSessionCount()).toBe(5);
    unregisterChild();
    setTelemetryActivityEnabled(true);
    expect(getInteractionTelemetry()).toMatchObject({
      activeLeases: 3,
      queuedUpdates: 7,
    });
    expect(getRealtimeSessionCount()).toBe(0);
    unregisterPrimary();
    setTelemetryActivityEnabled(true);
    expect(getInteractionTelemetry()).toMatchObject({
      activeLeases: 0,
      queuedUpdates: 0,
    });
    expect(getRealtimeSessionCount()).toBe(0);
  });
});
