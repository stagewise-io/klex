import { describe, expect, it } from 'vitest';

import { InstinctHistoryDeltaTracker } from './history-delta';

const message = (id: string) => ({
  id,
  role: 'user' as const,
  parts: [{ type: 'text' as const, text: id }],
});

describe('InstinctHistoryDeltaTracker', () => {
  it('reports the initial history and advances only when accepted', () => {
    const tracker = new InstinctHistoryDeltaTracker();
    const first = tracker.compute([message('a'), message('b')]);
    expect(first.delta).toMatchObject({
      initial: true,
      added: [{ id: 'a' }, { id: 'b' }],
      removedIds: [],
    });
    expect(tracker.compute([message('a')]).delta.initial).toBe(true);
    tracker.accept(first);
    expect(tracker.compute([message('a'), message('c')]).delta).toMatchObject({
      initial: false,
      added: [{ id: 'c' }],
      removedIds: ['b'],
    });
  });

  it('detects inserts in the middle and does not mutate the baseline', () => {
    const tracker = new InstinctHistoryDeltaTracker();
    tracker.accept(tracker.compute([message('a'), message('c')]));
    const pending = tracker.compute([message('a'), message('b'), message('c')]);
    expect(pending.delta.added.map(({ id }) => id)).toEqual(['b']);
    expect(tracker.compute([message('a'), message('c')]).delta.added).toEqual(
      [],
    );
    tracker.accept(pending);
    expect(
      tracker.compute([message('a'), message('b'), message('c')]).delta.added,
    ).toEqual([]);
  });
});
