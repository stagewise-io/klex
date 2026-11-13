import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PollBatch } from './poll-driver.js';
import {
  runStreamLoop,
  type StreamOpenParams,
  type StreamSink,
} from './stream-driver.js';

type Script = (
  params: StreamOpenParams,
  sink: StreamSink,
  signal: AbortSignal,
) => Promise<void> | void;

const occ = (id: string, cursor: string | null) => ({
  eventId: id,
  name: 'x',
  timestamp: '2026-01-01T00:00:00Z',
  data: {},
  cursor,
});

function harness(scripts: Script[]) {
  const controller = new AbortController();
  const opens: StreamOpenParams[] = [];
  const batches: PollBatch[] = [];
  const queue = [...scripts];
  const base = {
    port: {
      open: async (p: StreamOpenParams, s: StreamSink, sig: AbortSignal) => {
        opens.push(p);
        const next = queue.shift();
        if (!next) {
          controller.abort();
          return;
        }
        await next(p, s, sig);
      },
    },
    name: 'x',
    signal: controller.signal,
    onBatch: (b: PollBatch) => {
      batches.push(b);
    },
    sleep: async () => undefined,
    random: () => 0,
  };
  return { base, opens, batches, controller };
}

afterEach(() => vi.useRealTimers());

describe('runStreamLoop', () => {
  it('reconnects when the server never activates the stream', async () => {
    vi.useFakeTimers();
    const h = harness([
      (_p, _s, signal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        }),
    ]);
    const done = runStreamLoop({ ...h.base, activationTimeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(101);
    await done;
    expect(h.opens).toHaveLength(2);
    expect(h.opens[1]?.cursor).toBeNull();
  });
  it('delivers active/event/heartbeat and reconnects from the last cursor', async () => {
    const h = harness([
      (_p, s) => {
        s.active({ cursor: 'c0', heartbeatMs: 1000 });
        s.event({
          ...occ('1', 'c1'),
          _meta: { 'example.com/project': 'production' },
        });
        s.heartbeat({ cursor: 'c2' });
      },
    ]);
    await runStreamLoop(h.base);
    expect(h.batches.map((b) => b.cursor)).toEqual(['c0', 'c1', 'c2']);
    expect(h.batches[1]?.events[0]?.eventId).toBe('1');
    expect(h.batches[1]?.events[0]?._meta).toEqual({
      'example.com/project': 'production',
    });
    expect(h.opens[0]?.cursor).toBeNull();
    expect(h.opens[1]?.cursor).toBe('c2');
  });

  it('reports truncation from a mid-stream active', async () => {
    const h = harness([
      (_p, s) => {
        s.active({ cursor: 'fresh', truncated: true, heartbeatMs: 1000 });
      },
    ]);
    await runStreamLoop(h.base);
    expect(h.batches[0]?.truncated).toBe(true);
  });

  it('never lets a null heartbeat cursor replace a real one', async () => {
    const h = harness([
      (_p, s) => {
        s.active({ cursor: 'c1', heartbeatMs: 1000 });
        s.heartbeat({ cursor: null });
      },
    ]);
    await runStreamLoop(h.base);
    expect(h.batches).toHaveLength(1);
    expect(h.opens[1]?.cursor).toBe('c1');
  });

  it('reconnects from the last handled cursor when the consumer fails', async () => {
    const h = harness([
      (_p, s) => {
        s.active({ cursor: 'c0', heartbeatMs: 1000 });
        s.event(occ('1', 'c1'));
      },
    ]);
    let fail = true;
    await runStreamLoop({
      ...h.base,
      onBatch: (b) => {
        if (b.events.length > 0 && fail) {
          fail = false;
          throw new Error('down');
        }
        h.batches.push(b);
      },
    });
    expect(h.opens[1]?.cursor).toBe('c0');
  });

  it('keeps the stream open on notifications/events/error', async () => {
    const h = harness([
      (_p, s) => {
        s.active({ cursor: 'c0', heartbeatMs: 1000 });
        s.error({ error: { code: -1, message: 'upstream blip' } });
        s.event(occ('1', 'c1'));
      },
    ]);
    const onError = vi.fn();
    await runStreamLoop({ ...h.base, onError });
    expect(onError).toHaveBeenCalled();
    expect(h.batches.map((b) => b.cursor)).toContain('c1');
  });

  it('stops and reports on notifications/events/terminated', async () => {
    const h = harness([
      (_p, s) => {
        s.terminated({ error: { code: -32024, message: 'Forbidden' } });
      },
    ]);
    const onTerminated = vi.fn();
    await runStreamLoop({ ...h.base, onTerminated });
    expect(onTerminated).toHaveBeenCalledWith({
      code: -32024,
      message: 'Forbidden',
    });
    expect(h.opens).toHaveLength(1);
  });

  it('stops on a terminal JSON-RPC error and retries other failures', async () => {
    const h = harness([
      () => {
        throw new Error('network');
      },
      () => {
        throw Object.assign(new Error('nope'), { code: -32023 });
      },
    ]);
    const onTerminated = vi.fn();
    await runStreamLoop({ ...h.base, onTerminated });
    expect(h.opens).toHaveLength(2);
    expect(onTerminated).toHaveBeenCalledTimes(1);
  });

  it('treats 3x heartbeatMs of silence as a dead stream', async () => {
    vi.useFakeTimers();
    const h = harness([
      (_p, s, signal) => {
        s.active({ cursor: 'c0', heartbeatMs: 100 });
        return new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
      },
    ]);
    const done = runStreamLoop(h.base);
    await vi.advanceTimersByTimeAsync(299);
    expect(h.opens).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5);
    await done;
    expect(h.opens).toHaveLength(2);
    expect(h.opens[1]?.cursor).toBe('c0');
  });
});
