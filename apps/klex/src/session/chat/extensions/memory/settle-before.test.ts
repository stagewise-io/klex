import { describe, expect, it, vi } from 'vitest';

import { settleBefore } from './settle-before';

describe('settleBefore', () => {
  it('resolves true when the promise settles before the deadline', async () => {
    const promise = Promise.resolve('done');
    const deadline = Date.now() + 10_000;
    expect(await settleBefore(promise, deadline)).toBe(true);
  });

  it('resolves false when the deadline has already passed', async () => {
    const promise = new Promise(() => undefined);
    const deadline = Date.now() - 1;
    expect(await settleBefore(promise, deadline)).toBe(false);
  });

  it('resolves false when the timeout fires before the promise settles', async () => {
    vi.useFakeTimers();
    const promise = new Promise(() => undefined);
    const deadline = Date.now() + 100;
    const result = settleBefore(promise, deadline);
    await vi.advanceTimersByTimeAsync(101);
    expect(await result).toBe(false);
    vi.useRealTimers();
  });

  it('rejects when the promise rejects', async () => {
    const promise = Promise.reject(new Error('boom'));
    const deadline = Date.now() + 10_000;
    await expect(settleBefore(promise, deadline)).rejects.toThrow('boom');
  });

  it('clears the timeout when the promise settles first', async () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const promise = Promise.resolve('done');
    const deadline = Date.now() + 10_000;
    await settleBefore(promise, deadline);
    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
    vi.useRealTimers();
  });
});
