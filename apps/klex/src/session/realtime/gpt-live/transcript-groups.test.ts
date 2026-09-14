import { describe, expect, it } from 'vitest';

import { createGPTLiveTranscriptGrouper } from './transcript-groups';

describe('GPT-Live transcript grouping', () => {
  it('preserves exact fragments while grouping nearby same-speaker intervals', () => {
    const groups = createGPTLiveTranscriptGrouper();
    expect(
      groups.add({
        eventId: 'u1',
        speaker: 'user',
        delta: 'hello  ',
        startMs: 10,
        endMs: 20,
      }),
    ).toEqual([]);
    groups.add({
      eventId: 'u2',
      speaker: 'user',
      delta: 'hello',
      startMs: 21,
      endMs: 30,
    });
    expect(groups.flush()).toEqual([
      {
        eventId: 'gpt-live:transcript:user:u1',
        speaker: 'user',
        text: 'hello  hello',
        startMs: 10,
        endMs: 30,
      },
    ]);
  });

  it('keeps overlapping speakers separate and flushes long gaps', () => {
    const groups = createGPTLiveTranscriptGrouper();
    groups.add({
      eventId: 'u1',
      speaker: 'user',
      delta: 'u',
      startMs: 0,
      endMs: 20,
    });
    groups.add({
      eventId: 'a1',
      speaker: 'assistant',
      delta: 'a',
      startMs: 10,
      endMs: 30,
    });
    expect(
      groups.add({
        eventId: 'u2',
        speaker: 'user',
        delta: 'late',
        startMs: 1_000,
        endMs: 1_020,
      }),
    ).toEqual([
      {
        eventId: 'gpt-live:transcript:user:u1',
        speaker: 'user',
        text: 'u',
        startMs: 0,
        endMs: 20,
      },
    ]);
    expect(groups.flush().map((group) => group.speaker)).toEqual([
      'assistant',
      'user',
    ]);
  });

  it('merges at inclusive gap, duration, and character boundaries', () => {
    const gap = createGPTLiveTranscriptGrouper();
    gap.add({
      eventId: 'gap-1',
      speaker: 'user',
      delta: 'a',
      startMs: 0,
      endMs: 10,
    });
    gap.add({
      eventId: 'gap-2',
      speaker: 'user',
      delta: 'b',
      startMs: 760,
      endMs: 761,
    });
    expect(gap.flush().map((group) => group.text)).toEqual(['ab']);

    const duration = createGPTLiveTranscriptGrouper({
      maxGroupDurationMs: 10,
    });
    duration.add({
      eventId: 'duration-1',
      speaker: 'user',
      delta: 'a',
      startMs: 0,
      endMs: 1,
    });
    duration.add({
      eventId: 'duration-2',
      speaker: 'user',
      delta: 'b',
      startMs: 9,
      endMs: 10,
    });
    expect(duration.flush().map((group) => group.text)).toEqual(['ab']);

    const characters = createGPTLiveTranscriptGrouper({
      maxGroupCharacters: 2,
    });
    characters.add({
      eventId: 'characters-1',
      speaker: 'user',
      delta: 'a',
      startMs: 0,
      endMs: 1,
    });
    characters.add({
      eventId: 'characters-2',
      speaker: 'user',
      delta: 'b',
      startMs: 2,
      endMs: 3,
    });
    expect(characters.flush().map((group) => group.text)).toEqual(['ab']);
  });

  it('splits just beyond gap, duration, and character boundaries', () => {
    const gap = createGPTLiveTranscriptGrouper();
    gap.add({
      eventId: 'gap-1',
      speaker: 'user',
      delta: 'a',
      startMs: 0,
      endMs: 10,
    });
    const gapResult = gap.add({
      eventId: 'gap-2',
      speaker: 'user',
      delta: 'b',
      startMs: 761,
      endMs: 762,
    });
    expect([...gapResult, ...gap.flush()].map((group) => group.text)).toEqual([
      'a',
      'b',
    ]);

    const duration = createGPTLiveTranscriptGrouper({
      maxGroupDurationMs: 10,
    });
    duration.add({
      eventId: 'duration-1',
      speaker: 'user',
      delta: 'a',
      startMs: 0,
      endMs: 1,
    });
    const durationResult = duration.add({
      eventId: 'duration-2',
      speaker: 'user',
      delta: 'b',
      startMs: 9,
      endMs: 11,
    });
    expect(
      [...durationResult, ...duration.flush()].map((group) => group.text),
    ).toEqual(['a', 'b']);

    const characters = createGPTLiveTranscriptGrouper({
      maxGroupCharacters: 2,
    });
    characters.add({
      eventId: 'characters-1',
      speaker: 'user',
      delta: 'a',
      startMs: 0,
      endMs: 1,
    });
    const characterResult = characters.add({
      eventId: 'characters-2',
      speaker: 'user',
      delta: 'bc',
      startMs: 2,
      endMs: 3,
    });
    expect(
      [...characterResult, ...characters.flush()].map((group) => group.text),
    ).toEqual(['a', 'bc']);
  });

  it('bounds groups by character count and duration', () => {
    const groups = createGPTLiveTranscriptGrouper({
      maxGroupCharacters: 5,
      maxGroupDurationMs: 10,
    });
    groups.add({
      eventId: 'u1',
      speaker: 'user',
      delta: 'hello',
      startMs: 0,
      endMs: 5,
    });
    expect(
      groups.add({
        eventId: 'u2',
        speaker: 'user',
        delta: '!',
        startMs: 6,
        endMs: 8,
      }),
    ).toMatchObject([{ text: 'hello' }]);
    expect(
      groups.add({
        eventId: 'u3',
        speaker: 'user',
        delta: 'next',
        startMs: 9,
        endMs: 20,
      }),
    ).toMatchObject([{ text: '!' }]);
  });

  it('bounds deduplication state and evicts the oldest event ID', () => {
    const groups = createGPTLiveTranscriptGrouper({ maxSeenEventIds: 1 });
    const fragment = {
      eventId: 'u1',
      speaker: 'user' as const,
      delta: 'once',
      startMs: 0,
      endMs: 1,
    };
    groups.add(fragment);
    groups.add({ ...fragment, eventId: 'u2', delta: ' twice' });
    groups.add({ ...fragment, delta: ' again' });
    expect(groups.flush()[0]?.text).toBe('once twice again');
  });

  it('flushes interleaved groups in global timeline order', () => {
    const groups = createGPTLiveTranscriptGrouper();
    groups.add({
      eventId: 'user-later',
      speaker: 'user',
      delta: 'later',
      startMs: 100,
      endMs: 110,
    });
    groups.add({
      eventId: 'assistant-earlier',
      speaker: 'assistant',
      delta: 'earlier',
      startMs: 50,
      endMs: 60,
    });
    groups.add({
      eventId: 'user-earlier',
      speaker: 'user',
      delta: 'first',
      startMs: 20,
      endMs: 30,
    });

    expect(groups.flush().map((group) => group.text)).toEqual([
      'first',
      'earlier',
      'later',
    ]);
  });

  it('discards fragments older than an already emitted group', () => {
    const groups = createGPTLiveTranscriptGrouper();
    groups.add({
      eventId: 'later',
      speaker: 'user',
      delta: 'later',
      startMs: 100,
      endMs: 110,
    });
    expect(
      groups.add({
        eventId: 'latest',
        speaker: 'user',
        delta: 'latest',
        startMs: 1_000,
        endMs: 1_010,
      }),
    ).toMatchObject([{ text: 'later', startMs: 100 }]);

    expect(
      groups.add({
        eventId: 'too-late',
        speaker: 'assistant',
        delta: 'too late',
        startMs: 0,
        endMs: 10,
      }),
    ).toEqual([]);
    expect(groups.flush()).toMatchObject([{ text: 'latest', startMs: 1_000 }]);
  });

  it('fails closed when out-of-order fragments fill the pending bound', () => {
    const groups = createGPTLiveTranscriptGrouper({ maxPendingGroups: 1 });
    groups.add({
      eventId: 'latest',
      speaker: 'user',
      delta: 'latest',
      startMs: 20,
      endMs: 21,
    });
    groups.add({
      eventId: 'earlier',
      speaker: 'user',
      delta: 'earlier',
      startMs: 10,
      endMs: 11,
    });
    expect(() =>
      groups.add({
        eventId: 'earliest',
        speaker: 'user',
        delta: 'earliest',
        startMs: 0,
        endMs: 1,
      }),
    ).toThrow('pending transcript group limit');
  });

  it('rejects a single fragment larger than the group limit', () => {
    const groups = createGPTLiveTranscriptGrouper({ maxGroupCharacters: 5 });
    expect(() =>
      groups.add({
        eventId: 'oversized',
        speaker: 'user',
        delta: '123456',
        startMs: 0,
        endMs: 1,
      }),
    ).toThrow('exceeds group character limit');
  });

  it('deduplicates provider fragments by stable event ID', () => {
    const groups = createGPTLiveTranscriptGrouper();
    const fragment = {
      eventId: 'u1',
      speaker: 'user' as const,
      delta: 'once',
      startMs: 0,
      endMs: 1,
    };
    groups.add(fragment);
    groups.add(fragment);
    expect(groups.flush()[0]?.text).toBe('once');
  });
});
