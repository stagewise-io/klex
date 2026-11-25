import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ExtendedUIMessage } from '@/session/chat/message-types';

import { createMatcherEngine, project } from './matchers';

const workers = vi.hoisted(() => ({ instances: [] as unknown[] }));
vi.mock('node:worker_threads', () => ({
  Worker: class extends EventEmitter {
    constructor() {
      super();
      workers.instances.push(this);
    }
    ref = vi.fn();
    unref = vi.fn();
    postMessage = vi.fn();
    terminate = vi.fn(async () => 0);
  },
}));
afterEach(() => {
  workers.instances.length = 0;
  vi.useRealTimers();
});
describe('matcher isolation', () => {
  it('serializes concurrent regexes and isolates cancellation from queued work', async () => {
    vi.useFakeTimers();
    const engine = createMatcherEngine(vi.fn());
    const controller = new AbortController();
    const rules = [
      {
        type: 'eventDataPattern' as const,
        server: 'test',
        conditions: [{ path: 'name', match: 'regex' as const, value: '^Ada$' }],
      },
    ];
    const evidence = (name: string) => ({
      text: [],
      tools: [],
      events: [{ server: 'test', value: { name } }],
    });
    const first = engine.match(
      evidence('Ada'),
      rules,
      undefined,
      controller.signal,
    );
    const rejected = expect(first).rejects.toThrow();
    const second = engine.match(evidence('Bob'), rules);
    await vi.advanceTimersByTimeAsync(0);
    const worker = workers.instances[0] as EventEmitter & {
      postMessage: ReturnType<typeof vi.fn>;
    };
    worker.emit('message', 'ready');
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    controller.abort();
    await rejected;
    await vi.advanceTimersByTimeAsync(0);
    const next = workers.instances[1] as EventEmitter;
    next.emit('message', 'ready');
    next.emit('message', false);
    expect(await second).toBe(0);
  });
  it('cancels queued regex work immediately without advancing the worker queue', async () => {
    vi.useFakeTimers();
    const engine = createMatcherEngine(vi.fn());
    const rules = [
      {
        type: 'eventDataPattern' as const,
        server: 'test',
        conditions: [{ path: 'name', match: 'regex' as const, value: '^Ada$' }],
      },
    ];
    const evidence = (name: string) => ({
      text: [],
      tools: [],
      events: [{ server: 'test', value: { name } }],
    });
    const first = engine.match(evidence('Ada'), rules);
    const controller = new AbortController();
    const queued = engine.match(
      evidence('Bob'),
      rules,
      undefined,
      controller.signal,
    );
    const rejected = expect(queued).rejects.toThrow('Cancelled queued match');
    const third = engine.match(evidence('Cara'), rules);
    await vi.advanceTimersByTimeAsync(0);
    const worker = workers.instances[0] as EventEmitter & {
      postMessage: ReturnType<typeof vi.fn>;
      terminate: ReturnType<typeof vi.fn>;
    };
    controller.abort(new Error('Cancelled queued match'));
    await vi.advanceTimersByTimeAsync(0);
    await rejected;
    expect(workers.instances).toHaveLength(1);
    expect(worker.postMessage).not.toHaveBeenCalled();
    expect(worker.terminate).not.toHaveBeenCalled();
    worker.emit('message', 'ready');
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    worker.emit('message', true);
    expect(await first).toBe(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(worker.postMessage).toHaveBeenCalledTimes(2);
    expect(worker.postMessage).toHaveBeenLastCalledWith({
      value: 'Cara',
      pattern: '^Ada$',
    });
    worker.emit('message', false);
    expect(await third).toBe(0);
  });
  it('routes different concurrent results through the reused worker', async () => {
    vi.useFakeTimers();
    const engine = createMatcherEngine(vi.fn());
    const rules = [
      {
        type: 'eventDataPattern' as const,
        server: 'test',
        conditions: [{ path: 'name', match: 'regex' as const, value: '^Ada$' }],
      },
    ];
    const evidence = (name: string) => ({
      text: [],
      tools: [],
      events: [{ server: 'test', value: { name } }],
    });
    const first = engine.match(evidence('Ada'), rules);
    const second = engine.match(evidence('Bob'), rules);
    await vi.advanceTimersByTimeAsync(0);
    const worker = workers.instances[0] as EventEmitter & {
      postMessage: ReturnType<typeof vi.fn>;
    };
    worker.emit('message', 'ready');
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    worker.emit('message', true);
    expect(await first).toBe(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(worker.postMessage).toHaveBeenCalledTimes(2);
    worker.emit('message', false);
    expect(await second).toBe(0);
    expect(workers.instances).toHaveLength(1);
  });
  it.each(['memory', 'memory-update', 'memory-detail'])(
    'excludes generated %s text',
    (tag) => {
      expect(
        project({
          id: 'generated',
          role: 'user',
          parts: [
            { type: 'text', text: `<${tag} filename="x">trigger</${tag}>` },
          ],
        } as ExtendedUIMessage).text,
      ).toEqual([]);
    },
  );
  it.each(['memory', 'memory-update', 'memory-detail'])(
    'excludes generated line-format %s text',
    (kind) => {
      expect(
        project({
          id: 'generated',
          role: 'user',
          parts: [{ type: 'text', text: `${kind} "Ada.md"\nfacts\n¦trigger` }],
        } as ExtendedUIMessage).text,
      ).toEqual([]);
    },
  );
  it.each([
    'Memory of Ada',
    'memory leak in production',
    'Memory is important\ntrigger',
    'memory-update the deployment',
    'memory-detail about Ada',
    'Memory "Ada.md"\nfacts\n¦trigger',
    'memory Ada.md\nfacts\n¦trigger',
    'memory "Ada.md" is ordinary prose',
  ])('retains ordinary prose: %s', async (text) => {
    const projection = project({
      id: 'prose',
      role: 'user',
      parts: [{ type: 'text', text }],
    } as ExtendedUIMessage);
    expect(projection.text).toEqual([text.toLowerCase()]);
    expect(
      await createMatcherEngine(vi.fn()).match(projection, [
        { type: 'contentPattern', pattern: 'memory' },
      ]),
    ).toBeGreaterThan(0);
  });
  it.each(['tool-recallFromMemory', 'realtime'])(
    'excludes generated recall evidence from %s',
    (kind) => {
      const part =
        kind === 'realtime'
          ? {
              type: 'data-context',
              data: {
                sourceEnv: 'local',
                metadata: {
                  kind: 'realtime-tool-call',
                  toolName: 'recallFromMemory',
                },
                content: [{ type: 'text', text: 'trigger' }],
              },
            }
          : {
              type: kind,
              state: 'output-available',
              toolCallId: 'recall',
              input: { question: 'trigger' },
              output: { answer: 'trigger' },
            };
      expect(
        project({
          id: 'recall',
          role: 'assistant',
          parts: [part],
        } as ExtendedUIMessage),
      ).toEqual({ text: [], events: [], tools: [] });
    },
  );
  it('retries the same evidence after a worker startup timeout without disabling the pattern', async () => {
    vi.useFakeTimers();
    const timeout = vi.fn();
    const engine = createMatcherEngine(timeout);
    const evidence = {
      text: [],
      tools: [],
      events: [{ server: 'test', value: { name: 'Ada' } }],
    };
    const rules = [
      {
        type: 'eventDataPattern' as const,
        server: 'test',
        conditions: [{ path: 'name', match: 'regex' as const, value: '^A.a$' }],
      },
    ];
    const pending = engine.match(evidence, rules);
    const rejected = expect(pending).rejects.toThrow('failed to become ready');
    await vi.advanceTimersByTimeAsync(10001);
    await rejected;
    expect(timeout).not.toHaveBeenCalled();
    const retry = engine.match(evidence, rules);
    await vi.advanceTimersByTimeAsync(0);
    const worker = workers.instances[1] as EventEmitter;
    worker.emit('message', 'ready');
    worker.emit('message', true);
    expect(await retry).toBe(2);
  });
  it('starts the regex deadline only after worker readiness and still disables runaway execution', async () => {
    vi.useFakeTimers();
    const timeout = vi.fn();
    const engine = createMatcherEngine(timeout);
    const evidence = {
      text: [],
      tools: [],
      events: [{ server: 'test', value: { name: 'Ada' } }],
    };
    const rules = [
      {
        type: 'eventDataPattern' as const,
        server: 'test',
        conditions: [{ path: 'name', match: 'regex' as const, value: '^A.a$' }],
      },
    ];
    const pending = engine.match(evidence, [...rules]);
    await vi.advanceTimersByTimeAsync(500);
    const worker = workers.instances[0] as EventEmitter & {
      postMessage: ReturnType<typeof vi.fn>;
    };
    expect(timeout).not.toHaveBeenCalled();
    worker.emit('message', 'ready');
    expect(worker.postMessage).toHaveBeenCalledWith({
      value: 'Ada',
      pattern: '^A.a$',
    });
    worker.emit('message', true);
    expect(await pending).toBe(2);
    const runaway = engine.match(
      { ...evidence, events: [{ server: 'test', value: { name: 'Another' } }] },
      [...rules],
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(workers.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(151);
    expect(await runaway).toBe(0);
    expect(timeout).toHaveBeenCalledOnce();
  });
});
