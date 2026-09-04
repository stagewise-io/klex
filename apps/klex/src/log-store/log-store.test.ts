import { describe, expect, it, vi } from 'vitest';

import type { CapturedLogEntry } from '@stagewise/logger';

import { createLogStore } from './log-store';

function entry(message: string): CapturedLogEntry {
  return {
    timestamp: new Date(0),
    level: 'INFO',
    loggerName: 'test',
    message,
    fields: null,
    sequence: 0,
  };
}

describe('LogStore', () => {
  it('retains only the configured number of recent entries', () => {
    const store = createLogStore(2);
    store.add(entry('one'));
    store.add(entry('two'));
    store.add(entry('three'));

    expect(store.getEntries().map((item) => item.message)).toEqual([
      'two',
      'three',
    ]);
  });

  it('notifies subscribers when an entry is added', () => {
    const store = createLogStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.add(entry('one'));
    unsubscribe();
    store.add(entry('two'));

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('isolates subscriber failures', () => {
    const store = createLogStore();
    const listener = vi.fn();
    store.subscribe(() => {
      throw new Error('failed listener');
    });
    store.subscribe(listener);

    expect(() => store.add(entry('one'))).not.toThrow();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
