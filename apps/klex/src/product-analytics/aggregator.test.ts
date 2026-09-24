import { describe, expect, it } from 'vitest';

import { SessionAggregator } from './aggregator';

describe('SessionAggregator', () => {
  it('aggregates totals and per-session max', () => {
    const aggregator = new SessionAggregator();
    const a = aggregator.openSession();
    const b = aggregator.openSession();
    aggregator.openSession(); // idle session: counted as started only

    a.recordTurn(3);
    for (let i = 0; i < 6; i++) b.recordTurn(2);
    b.close();

    expect(aggregator.snapshotAndReset()).toEqual({
      sessionsStarted: 3,
      sessionsEnded: 1,
      sessionsActive: 2,
      turnsTotal: 7,
      stepsTotal: 15,
      turnsPerSessionMax: 6,
      stepsPerSessionMax: 12,
    });
  });

  it('resets after snapshot and carries open handles with zeroed counts', () => {
    const aggregator = new SessionAggregator();
    const open = aggregator.openSession();
    const closed = aggregator.openSession();
    open.recordTurn(1);
    closed.recordTurn(1);
    closed.close();
    aggregator.snapshotAndReset();

    expect(aggregator.snapshotAndReset()).toMatchObject({
      sessionsStarted: 0,
      sessionsEnded: 0,
      sessionsActive: 0,
      turnsTotal: 0,
    });

    open.recordTurn(4);
    closed.recordTurn(9); // after close: ignored
    expect(aggregator.snapshotAndReset()).toMatchObject({
      sessionsActive: 1,
      turnsTotal: 1,
      stepsTotal: 4,
    });
    open.close();
    expect(aggregator.snapshotAndReset().sessionsEnded).toBe(1);
  });

  it('counts close only once and ignores invalid step counts', () => {
    const aggregator = new SessionAggregator();
    const handle = aggregator.openSession();
    handle.recordTurn(Number.NaN);
    handle.recordTurn(-5);
    handle.close();
    handle.close();
    expect(aggregator.snapshotAndReset()).toMatchObject({
      sessionsEnded: 1,
      turnsTotal: 2,
      stepsTotal: 0,
    });
  });

  it('exposes no session identity through the handle', () => {
    const handle = new SessionAggregator().openSession();
    expect(Object.keys(handle).sort()).toEqual(['close', 'recordTurn']);
  });
});
