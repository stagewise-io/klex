import { describe, expect, it, vi } from 'vitest';

import { BoundedAsyncQueue } from './async-queue';

describe('BoundedAsyncQueue', () => {
  it('blocks writers at capacity and promotes them in order', async () => {
    const queue = new BoundedAsyncQueue<number>(1);
    await queue.push(1);
    const blocked = queue.push(2);
    const settled = vi.fn();
    void blocked.then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    const iterator = queue[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ value: 1, done: false });
    await expect(blocked).resolves.toBeUndefined();
    await expect(iterator.next()).resolves.toEqual({ value: 2, done: false });
  });

  it('drops the oldest item without blocking when configured', async () => {
    const dropped: number[] = [];
    const queue = new BoundedAsyncQueue<number>(2, {
      overflow: 'drop-oldest',
      onDrop: (value) => dropped.push(value),
    });
    await queue.push(1);
    await queue.push(2);
    await queue.push(3);
    await queue.push(4);

    const iterator = queue[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ value: 3, done: false });
    await expect(iterator.next()).resolves.toEqual({ value: 4, done: false });
    expect(dropped).toEqual([1, 2]);
  });

  it('delivers directly to pending readers in drop-oldest mode', async () => {
    const dropped = vi.fn();
    const queue = new BoundedAsyncQueue<number>(1, {
      overflow: 'drop-oldest',
      onDrop: dropped,
    });
    const next = queue[Symbol.asyncIterator]().next();

    await queue.push(1);

    await expect(next).resolves.toEqual({ value: 1, done: false });
    expect(dropped).not.toHaveBeenCalled();
  });

  it('retains one terminal marker when closing at capacity', async () => {
    const queue = new BoundedAsyncQueue<number>(1);
    await queue.push(1);
    queue.pushTerminal(2);
    queue.close();

    const iterator = queue[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ value: 1, done: false });
    await expect(iterator.next()).resolves.toEqual({ value: 2, done: false });
    await expect(iterator.next()).resolves.toEqual({
      value: undefined,
      done: true,
    });
  });

  it('completes pending readers on normal close', async () => {
    const queue = new BoundedAsyncQueue<number>(1);
    const next = queue[Symbol.asyncIterator]().next();
    queue.close();
    await expect(next).resolves.toEqual({ value: undefined, done: true });
  });

  it('cancels a pending read when its iterator returns', async () => {
    const queue = new BoundedAsyncQueue<number>(1);
    const iterator = queue[Symbol.asyncIterator]();
    const next = iterator.next();

    await iterator.return?.();

    await expect(next).resolves.toEqual({ value: undefined, done: true });
    await queue.push(1);
    await expect(queue[Symbol.asyncIterator]().next()).resolves.toEqual({
      value: 1,
      done: false,
    });
  });

  it('cancels every concurrent read when its iterator returns', async () => {
    const queue = new BoundedAsyncQueue<number>(1);
    const iterator = queue[Symbol.asyncIterator]();
    const reads = [iterator.next(), iterator.next(), iterator.next()];

    await iterator.return?.();

    await expect(Promise.all(reads)).resolves.toEqual([
      { value: undefined, done: true },
      { value: undefined, done: true },
      { value: undefined, done: true },
    ]);
    await queue.push(1);
    await expect(queue[Symbol.asyncIterator]().next()).resolves.toEqual({
      value: 1,
      done: false,
    });
  });

  it('rejects pending readers and writers on failure', async () => {
    const readerQueue = new BoundedAsyncQueue<number>(1);
    const read = readerQueue[Symbol.asyncIterator]().next();
    const failure = new Error('failed');
    readerQueue.close(failure);
    await expect(read).rejects.toBe(failure);

    const writerQueue = new BoundedAsyncQueue<number>(1);
    await writerQueue.push(1);
    const write = writerQueue.push(2);
    writerQueue.close(failure);
    await expect(write).rejects.toBe(failure);
    await expect(writerQueue.push(3)).rejects.toBe(failure);
  });

  it('propagates failure in drop-oldest mode', async () => {
    const queue = new BoundedAsyncQueue<number>(1, {
      overflow: 'drop-oldest',
    });
    await queue.push(1);
    const failure = new Error('failed');
    queue.close(failure);

    const iterator = queue[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ value: 1, done: false });
    await expect(iterator.next()).rejects.toBe(failure);
    await expect(queue.push(2)).rejects.toBe(failure);
  });

  it('validates capacity', () => {
    expect(() => new BoundedAsyncQueue(0)).toThrow(
      'Queue capacity must be a positive integer',
    );
  });
});
