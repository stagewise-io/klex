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
