import { describe, expect, it, vi } from 'vitest';

import type { EventsPollResult } from '../spec.types.js';
import { EventsUnsupportedError } from './events-client.js';
import { type PollBatch, runPollLoop } from './poll-driver.js';

const occurrence = (id: string) => ({
  eventId: id,
  name: 'x',
  timestamp: '2026-01-01T00:00:00Z',
  data: {},
});

function harness(results: Array<EventsPollResult | Error>) {
  const controller = new AbortController();
  const calls: Array<Record<string, unknown>> = [];
  const sleeps: number[] = [];
  const batches: PollBatch[] = [];
  const queue = [...results];
  const poll = vi.fn(async (params: Record<string, unknown>) => {
    calls.push(params);
    const next = queue.shift();
    if (!next) {
      controller.abort();
      return { events: [], cursor: 'end' } as EventsPollResult;
    }
    if (next instanceof Error) throw next;
    return next;
  });
  const base = {
    client: { poll: poll as never },
    name: 'x',
    signal: controller.signal,
    onBatch: (b: PollBatch) => {
      batches.push(b);
    },
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    random: () => 0,
  };
  return { base, calls, sleeps, batches, controller };
}

describe('runPollLoop', () => {
  it('rate limits same-cursor hasMore responses, including duplicates', async () => {
    const h = harness([
      { events: [], cursor: 'c', hasMore: true },
      { events: [], cursor: 'c', hasMore: true },
      { events: [occurrence('1')], cursor: 'c', hasMore: true },
    ]);
    await runPollLoop(h.base);
    expect(h.sleeps).toEqual([1000, 1000]);
  });

  it('yields during an indefinitely advancing backlog', async () => {
    const h = harness(
      Array.from({ length: 70 }, (_, index) => ({
        events: [],
        cursor: String(index),
        hasMore: true,
      })),
    );
    await runPollLoop(h.base);
    expect(h.sleeps).toEqual([1000, 1000]);
  });

  it('forwards abort to in-flight polls and does not deliver after cancellation', async () => {
    const h = harness([]);
    const poll = vi.fn(
      async (_params, options) =>
        new Promise<EventsPollResult>((resolve) => {
          const signal = options.request.signal;
          signal.addEventListener('abort', () =>
            resolve({ events: [occurrence('1')] }),
          );
          h.controller.abort();
        }),
    );
    await runPollLoop({ ...h.base, client: { poll } });
    expect(h.batches).toEqual([]);
    expect(poll.mock.calls[0]?.[1].request.signal).toBe(h.controller.signal);
  });
  it('threads the cursor and sends null on first poll', async () => {
    const h = harness([
      { events: [occurrence('1')], cursor: 'c1' },
      { events: [], cursor: 'c2' },
    ]);
    await runPollLoop(h.base);
    expect(h.calls[0]?.['cursor']).toBeNull();
    expect(h.calls[1]?.['cursor']).toBe('c1');
    expect(h.calls[2]?.['cursor']).toBe('c2');
  });

  it('delivers empty batches so the cursor can advance', async () => {
    const h = harness([{ events: [], cursor: 'c1' }]);
    await runPollLoop(h.base);
    expect(h.batches[0]).toEqual({
      events: [],
      cursor: 'c1',
      truncated: false,
    });
  });

  it('re-polls immediately on hasMore and floors nextPollMs', async () => {
    const h = harness([
      { events: [], cursor: 'a', hasMore: true },
      { events: [], cursor: 'b', nextPollMs: 5 },
    ]);
    await runPollLoop(h.base);
    // hasMore => no sleep between poll 1 and 2; floor applied after poll 2.
    expect(h.sleeps[0]).toBe(1000);
    expect(h.calls[1]?.['cursor']).toBe('a');
  });

  it('reports truncation', async () => {
    const h = harness([{ events: [], cursor: 'a', truncated: true }]);
    await runPollLoop(h.base);
    expect(h.batches[0]?.truncated).toBe(true);
  });

  it('retries a failed batch with the same cursor (no loss)', async () => {
    const h = harness([
      { events: [occurrence('1')], cursor: 'c1' },
      { events: [occurrence('1')], cursor: 'c1' },
    ]);
    let first = true;
    await runPollLoop({
      ...h.base,
      onBatch: (b) => {
        if (first) {
          first = false;
          throw new Error('consumer down');
        }
        h.batches.push(b);
      },
    });
    expect(h.calls[0]?.['cursor']).toBeNull();
    expect(h.calls[1]?.['cursor']).toBeNull();
    expect(h.batches[0]?.cursor).toBe('c1');
  });

  it('backs off on transient errors then recovers', async () => {
    const h = harness([new Error('boom'), { events: [], cursor: 'a' }]);
    const onError = vi.fn();
    await runPollLoop({ ...h.base, onError });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(h.sleeps[0]).toBe(500);
  });

  it('clamps oversized server poll delays', async () => {
    const h = harness([{ events: [], nextPollMs: Number.MAX_VALUE }]);
    await runPollLoop(h.base);
    expect(h.sleeps).toEqual([2_147_483_647]);
  });

  it('stops on unsupported-extension errors without retrying', async () => {
    const h = harness([new EventsUnsupportedError()]);
    const onTerminated = vi.fn();
    await runPollLoop({ ...h.base, onTerminated });
    expect(onTerminated).toHaveBeenCalledTimes(1);
    expect(h.calls).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
  });

  it('stops on terminal errors', async () => {
    const h = harness([Object.assign(new Error('nope'), { code: -32024 })]);
    const onTerminated = vi.fn();
    await runPollLoop({ ...h.base, onTerminated });
    expect(onTerminated).toHaveBeenCalledTimes(1);
    expect(h.calls).toHaveLength(1);
  });
});
