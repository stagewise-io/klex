import { afterEach, describe, expect, it, vi } from 'vitest';

import { AdmissionGate, AdmissionRejectedError } from './admission';

afterEach(() => vi.useRealTimers());

describe('admission and pre-teardown quiescence', () => {
  it('continues ordinary shutdown when one deferred cancellation throws', async () => {
    const gate = new AdmissionGate();
    const work = gate.admitRoot();
    const preparing = gate.prepare();
    const replay = vi.fn();
    const settled = vi.fn();
    gate.background({}, replay, () => {
      throw new Error('cancellation failed');
    });
    gate.background({}, replay, settled);
    expect(() => gate.close()).not.toThrow();
    expect(await preparing).toEqual({
      outcome: 'aborted',
      reason: 'Runtime closed',
    });
    expect(settled).toHaveBeenCalledOnce();
    expect(replay).not.toHaveBeenCalled();
    expect(gate.status()).toMatchObject({
      state: 'closed',
      deferredWork: 0,
      reason: 'Deferred work cancellation failed',
    });
    work.release();
  });
  it('ordinary shutdown settles deferred ownership without replaying work', async () => {
    const gate = new AdmissionGate({ maxDescendants: 0 });
    const work = gate.admitRoot();
    const preparing = gate.prepare();
    const replay = vi.fn();
    const cancelled = vi.fn();
    gate.background({}, replay, cancelled);
    const checkpoint = work.run(() => gate.checkpoint());
    const stopped = expect(checkpoint).rejects.toThrow(AdmissionRejectedError);
    gate.close();
    await stopped;
    expect(await preparing).toEqual({
      outcome: 'aborted',
      reason: 'Runtime closed',
    });
    expect(cancelled).toHaveBeenCalledOnce();
    expect(replay).not.toHaveBeenCalled();
    expect(gate.status().deferredWork).toBe(0);
    work.release();
  });
  it('rejects an expired lease even before its timer callback runs', async () => {
    vi.useFakeTimers();
    const gate = new AdmissionGate({ graceMs: 10 });
    const result = await gate.prepare();
    if (result.outcome !== 'quiescent') throw new Error('Expected quiescence');
    vi.setSystemTime(Date.now() + 10);
    expect(() => gate.consume(result.lease)).toThrow(AdmissionRejectedError);
    expect(gate.status().state).toBe('open');
    gate.close();
  });

  it('expires an unconsumed quiescence lease without authorizing teardown', async () => {
    vi.useFakeTimers();
    const gate = new AdmissionGate({ graceMs: 10 });
    const first = await gate.prepare();
    if (first.outcome !== 'quiescent') throw new Error('Expected quiescence');
    await vi.advanceTimersByTimeAsync(10);
    expect(gate.status().state).toBe('open');
    expect(() => gate.consume(first.lease)).toThrow(AdmissionRejectedError);
    const second = await gate.prepare();
    if (second.outcome !== 'quiescent') throw new Error('Expected quiescence');
    expect(gate.abort('stale release', first.lease)).toBe(false);
    gate.consume(second.lease);
  });

  it('does not allow a caller to mutate validated descendant limits', async () => {
    const options = { maxDepth: 1, maxDescendants: 1 };
    const gate = new AdmissionGate(options);
    options.maxDepth = 100;
    options.maxDescendants = 100;
    const parent = gate.admit();
    const preparing = gate.prepare();
    const child = parent.run(() => gate.admit());
    expect(() => parent.run(() => gate.admit())).toThrow(
      AdmissionRejectedError,
    );
    expect(() => child.run(() => gate.admit())).toThrow(AdmissionRejectedError);
    parent.release();
    child.release();
    expect((await preparing).outcome).toBe('quiescent');
    gate.close();
  });
  it('pauses an admitted retry at its continuation bound without terminating it', async () => {
    vi.useFakeTimers();
    const gate = new AdmissionGate({ graceMs: 10, maxDescendants: 1 });
    const work = gate.admitRoot();
    const result = gate.prepare();
    await work.run(() => gate.checkpoint());
    let resumed = false;
    const next = work.run(async () => {
      await gate.checkpoint();
      resumed = true;
    });
    expect(resumed).toBe(false);
    await vi.advanceTimersByTimeAsync(10);
    expect((await result).outcome).toBe('aborted');
    await next;
    expect(resumed).toBe(true);
    expect(gate.status()).toMatchObject({ state: 'open', activeWork: 1 });
    work.release();
    gate.close();
  });

  it('retains a deferred callback whose rollback delivery throws', async () => {
    vi.useFakeTimers();
    const gate = new AdmissionGate({ graceMs: 10 });
    const work = gate.admitRoot();
    const result = gate.prepare();
    const callback = vi.fn((): void => {
      throw new Error('temporary delivery failure');
    });
    gate.background(callback, callback);
    await vi.advanceTimersByTimeAsync(10);
    expect((await result).outcome).toBe('aborted');
    expect(gate.status()).toMatchObject({
      deferredWork: 1,
      reason: 'Deferred work could not resume',
    });
    callback.mockImplementation(() => undefined);
    const retry = gate.prepare();
    await vi.advanceTimersByTimeAsync(10);
    expect((await retry).outcome).toBe('aborted');
    expect(callback).toHaveBeenCalledTimes(2);
    expect(gate.status().deferredWork).toBe(0);
    work.release();
    gate.close();
  });
  it('atomically closes root admission and waits for admitted work', async () => {
    const gate = new AdmissionGate();
    const work = gate.admitRoot();
    const result = gate.prepare();
    expect(gate.status()).toMatchObject({ state: 'draining', activeWork: 1 });
    expect(() => gate.admitRoot()).toThrow(AdmissionRejectedError);
    work.release();
    const prepared = await result;
    expect(prepared.outcome).toBe('quiescent');
    expect(gate.status().activeWork).toBe(0);
    gate.close();
  });

  it('defaults to 60 seconds and reopens without cancelling live work', async () => {
    vi.useFakeTimers();
    const gate = new AdmissionGate();
    const work = gate.admitRoot();
    const result = gate.prepare();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(gate.status().state).toBe('draining');
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toMatchObject({
      outcome: 'aborted',
      reason: 'Drain grace expired',
    });
    expect(gate.status()).toMatchObject({ state: 'open', activeWork: 1 });
    expect(work.run(() => 'still alive')).toBe('still alive');
    gate.admitRoot().release();
    work.release();
    gate.close();
  });

  it('allows only bounded descendants with a live, owned parent', async () => {
    const gate = new AdmissionGate({ maxDescendants: 1, maxDepth: 1 });
    const parent = gate.admitRoot();
    const result = gate.prepare();
    const child = parent.run(() => gate.admit());
    expect(() => child.run(() => gate.admit())).toThrow(AdmissionRejectedError);
    expect(() => parent.run(() => gate.admit())).toThrow(
      AdmissionRejectedError,
    );
    expect(() => parent.run(() => gate.admitRoot())).toThrow(
      AdmissionRejectedError,
    );
    parent.release();
    expect(() => parent.run(() => gate.admit())).toThrow(
      AdmissionRejectedError,
    );
    expect(gate.status().state).toBe('draining');
    child.release();
    expect((await result).outcome).toBe('quiescent');
    gate.close();
  });

  it('does not inherit admission from a released asynchronous context', async () => {
    const gate = new AdmissionGate();
    const parent = gate.admitRoot();
    let continueTask!: () => void;
    const late = parent.run(async () => {
      await new Promise<void>((resolve) => {
        continueTask = resolve;
      });
      return gate.admit();
    });
    parent.release();
    const result = await gate.prepare();
    expect(result.outcome).toBe('quiescent');
    continueTask();
    await expect(late).rejects.toThrow(AdmissionRejectedError);
    gate.close();
  });

  it('defers unrelated callbacks and preserves them on timeout', async () => {
    vi.useFakeTimers();
    const gate = new AdmissionGate({ graceMs: 20 });
    const work = gate.admit();
    const callback = vi.fn();
    const result = gate.prepare();
    work.run(() => gate.background(callback, callback));
    work.release();
    expect(callback).not.toHaveBeenCalled();
    expect(gate.status()).toMatchObject({
      state: 'draining',
      activeWork: 0,
      deferredWork: 1,
    });
    await vi.advanceTimersByTimeAsync(20);
    expect((await result).outcome).toBe('aborted');
    expect(callback).toHaveBeenCalledOnce();
    expect(gate.status()).toMatchObject({ state: 'open', deferredWork: 0 });
    gate.close();
  });

  it('refuses quiescence when persistence or participant safety is uncertain', async () => {
    const gate = new AdmissionGate();
    gate.register(() => ['Telegram pending queue is volatile']);
    expect(await gate.prepare()).toMatchObject({ outcome: 'aborted' });
    expect(gate.status()).toMatchObject({
      state: 'open',
      blockers: ['Telegram pending queue is volatile'],
    });
    gate.close();
    const uncertain = new AdmissionGate();
    uncertain.register(() => {
      throw new Error('persistence unavailable');
    });
    expect((await uncertain.prepare()).outcome).toBe('aborted');
    uncertain.close();
  });

  it('aborts when a safety proof becomes uncertain during drain', async () => {
    vi.useFakeTimers();
    const gate = new AdmissionGate();
    const work = gate.admit();
    let healthy = true;
    gate.register(() => (healthy ? [] : ['ACK uncertain']));
    const result = gate.prepare();
    healthy = false;
    await vi.advanceTimersByTimeAsync(10);
    expect((await result).outcome).toBe('aborted');
    expect(gate.status()).toMatchObject({ state: 'open', activeWork: 1 });
    work.release();
    gate.close();
  });

  it('fences competing maintenance callers, foreign and stale leases', async () => {
    const gate = new AdmissionGate();
    const first = await gate.prepare();
    if (first.outcome !== 'quiescent') throw new Error('Expected quiescence');
    expect(() => gate.prepare()).toThrow(AdmissionRejectedError);
    expect(() => gate.consume({ epoch: first.lease.epoch })).toThrow(
      AdmissionRejectedError,
    );
    expect(gate.abort('cancelled', first.lease)).toBe(true);
    const second = await gate.prepare();
    if (second.outcome !== 'quiescent') throw new Error('Expected quiescence');
    expect(gate.abort('stale cancellation', first.lease)).toBe(false);
    expect(() => gate.consume(first.lease)).toThrow(AdmissionRejectedError);
    const replacement = new AdmissionGate();
    expect(() => replacement.consume(second.lease)).toThrow(
      AdmissionRejectedError,
    );
    gate.consume(second.lease);
    expect(gate.abort('cannot revive closed runtime', second.lease)).toBe(
      false,
    );
    expect(() => gate.admitRoot()).toThrow(AdmissionRejectedError);
    replacement.close();
  });

  it('revalidates safety immediately before destructive handoff', async () => {
    const gate = new AdmissionGate();
    let safe = true;
    gate.register(() => (safe ? [] : ['persistence uncertain']));
    const result = await gate.prepare();
    if (result.outcome !== 'quiescent') throw new Error('Expected quiescence');
    safe = false;
    expect(() => gate.consume(result.lease)).toThrow(AdmissionRejectedError);
    gate.abort('uncertain', result.lease);
    gate.close();
  });

  it('rejects invalid grace and descendant bounds before closing admission', () => {
    expect(() => new AdmissionGate({ graceMs: Number.NaN })).toThrow(
      RangeError,
    );
    expect(() => new AdmissionGate({ maxDepth: -1 })).toThrow(RangeError);
    const gate = new AdmissionGate();
    expect(() => gate.prepare({ graceMs: -1 })).toThrow(RangeError);
    expect(gate.status().state).toBe('open');
    gate.close();
  });
});
