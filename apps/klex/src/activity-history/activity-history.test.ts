import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ExtendedUIMessage } from '@/session/chat/message-types';

import { activityMessageId, activityOrdinal } from './activity-history';
import { createActivityFixture, TEST_ACTIVITY_LIMITS } from './test-support';

const fixtures: Awaited<ReturnType<typeof createActivityFixture>>[] = [];
async function setup() {
  const fixture = await createActivityFixture();
  fixtures.push(fixture);
  return fixture;
}
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});
const ready = (now: number) => ({
  ...TEST_ACTIVITY_LIMITS,
  now,
  active: false,
  lastActivityAt: 0,
});

describe('canonical activity view', () => {
  it('shares sparse UTC time anchors across pending, range and page views', async () => {
    const { activities, append, setTime, now } = await setup();
    const first = await append('first');
    await append('second');
    setTime('2026-10-01T12:01:00Z');
    const last = await append('third');
    const pending = await activities.readPending(null, ready(now() + 600_000));
    const range = await activities.readRange(null, last.id, 40_000);
    const page = await activities.readPage(last.id, {
      firstSourceId: first.id,
      offset: 0,
      limit: 40_000,
      maxBytes: 100_000,
    });
    for (const result of [pending, range, page]) {
      expect(result?.text).toBe(
        '12:00 # your_output\ncontent: |\n~ first\n\n# your_output\ncontent: |\n~ second\n\n12:01 # your_output\ncontent: |\n~ third',
      );
    }
    expect(
      (await activities.readRange(first.id, last.id, 40_000))?.text,
    ).toMatch(/^12:00 #/);
  });

  it('repeats the time on date changes and does not advance it for filtered sources', async () => {
    const { activities, append, setTime } = await setup();
    const first = await append('first');
    setTime('2026-10-01T12:01:00Z');
    await append('hidden', 'user');
    await append('visible');
    setTime('2026-10-02T12:01:00Z');
    const last = await append('next day');
    const range = await activities.readRange(null, last.id, 40_000);
    expect(range?.text.match(/^12:01 #/gm)).toHaveLength(2);
    expect(range?.text).not.toContain('hidden');
    const page = await activities.readPage(first.id, {
      offset: 0,
      limit: 40_000,
      maxBytes: 100_000,
    });
    expect(page?.text).toMatch(/^12:00 #/);
  });
  it('preserves exclusions and consumes filtered-only sources', async () => {
    const { activities, append, now } = await setup();
    const hidden = await append('private raw user text', 'user');
    expect(
      (
        await activities.readPage(hidden.id, {
          offset: 0,
          limit: 1000,
          maxBytes: 10000,
        })
      )?.text,
    ).toBe('');
    const source = await append('keep the deployment command');
    const messageId = activityMessageId(source.id);
    if (!messageId) throw new Error('Missing SQLite message ID');
    expect(
      await activities.readPage(messageId, {
        offset: 0,
        limit: 1000,
        maxBytes: 10000,
      }),
    ).toMatchObject({
      id: source.id,
      text: expect.stringContaining('keep the deployment command'),
    });
    const batch = await activities.readPending(null, ready(now() + 600_000));
    expect(batch?.id).toBe(source.id);
    expect(batch?.text).toContain('keep the deployment command');
    expect(batch?.text).not.toContain('private raw user text');
    expect(
      await activities.readPending(source.id, ready(now() + 600_000)),
    ).toBeNull();
  });

  it('uses idle readiness without confusing an active long step for inactivity', async () => {
    const { activities, append, now } = await setup();
    await append('still working');
    expect(await activities.readPending(null, ready(now()))).toBeNull();
    expect(
      await activities.readPending(null, {
        ...ready(now() + 600_000),
        active: true,
      }),
    ).toBeNull();
    expect(
      await activities.readPending(null, {
        ...ready(now() + 600_000),
        lastActivityAt: now() + 599_000,
      }),
    ).toBeNull();
    expect(
      (await activities.readPending(null, ready(now() + 600_000)))?.text,
    ).toContain('still working');
  });

  it('splits at size, duration and UTC-date boundaries without persisting groups', async () => {
    const { activities, append, setTime, now, history } = await setup();
    const first = await append('first record');
    setTime('2026-10-02T12:00:00Z');
    const second = await append('second record');
    const batch = await activities.readPending(null, ready(now()));
    expect(batch?.id).toBe(first.id);
    expect(batch?.text).not.toContain('second record');
    expect(
      (await activities.readPending(first.id, ready(now() + 600_000)))?.id,
    ).toBe(second.id);
    expect(await history.activityManifest()).toHaveLength(2);
  });

  it('splits on rendered size independently of idle, duration and date', async () => {
    const { activities, append, now } = await setup();
    const first = await append('first');
    await append('second');
    const batch = await activities.readPending(null, {
      ...ready(now()),
      maxCharacters: 40,
    });
    expect(batch?.id).toBe(first.id);
    expect(batch?.text).toContain('~ first');
    expect(batch?.text).not.toContain('~ second');
    expect(batch!.text.length).toBeLessThanOrEqual(40);
  });

  it('bounds the first oversized source and advances past it without waiting for idle', async () => {
    const { activities, append, now } = await setup();
    const first = await append('x'.repeat(1000));
    const batch = await activities.readPending(null, {
      ...ready(now()),
      maxCharacters: 10,
    });
    expect(batch).toMatchObject({ id: first.id, truncated: true });
    expect(batch?.text).toHaveLength(10);
    expect(await activities.readPending(first.id, ready(now()))).toBeNull();
  });

  it('reads exactly the bounded range after the cursor through the boundary', async () => {
    const { activities, append } = await setup();
    const first = await append('range-one');
    const second = await append('range-two');
    const third = await append('range-three');
    const all = await activities.readRange(null, second.id, 10_000);
    expect(all?.text).toContain('range-one');
    expect(all?.text).toContain('range-two');
    expect(all?.text).not.toContain('range-three');
    expect(all?.id).toBe(second.id);
    const later = await activities.readRange(first.id, third.id, 10_000);
    expect(later?.text).not.toContain('range-one');
    expect(later?.text).toContain('range-two');
    expect(later?.text).toContain('range-three');
    expect(await activities.readRange(third.id, third.id, 10_000)).toBeNull();
  });

  it('keeps the tail of an oversized message in a range read', async () => {
    const { activities, append } = await setup();
    const only = await append(`HEAD${'x'.repeat(1000)}TAIL`);
    const batch = await activities.readRange(null, only.id, 50);
    expect(batch).toMatchObject({ id: only.id, truncated: true });
    expect(batch?.text.length).toBeLessThanOrEqual(50);
    expect(batch?.text).toContain('TAIL');
    expect(batch?.text).not.toContain('HEAD');
    expect(batch?.text).toMatch(/^12:00 /);
  });

  it('labels writer evidence including bounded oversized tails', async () => {
    const { activities, append } = await setup();
    const source = await append(`HEAD${'x'.repeat(2000)}TAIL`);
    const batch = await activities.readRange(null, source.id, 500, true);
    expect(batch?.text).toContain(`Source ${source.id}`);
    expect(batch?.text).toContain(`(${source.persistedAt})\n12:00 `);
    expect(batch?.text).toContain('TAIL');
    expect(batch?.text.length).toBeLessThanOrEqual(500);
    expect(batch?.sourceIds).toEqual([source.id]);
    expect(batch?.truncated).toBe(true);
  });

  it('anchors clipped multi-source tails to the first visible source minute', async () => {
    const { activities, append, setTime } = await setup();
    const first = await append('first');
    setTime('2026-10-01T12:05:00Z');
    const last = await append(`HEAD${'x'.repeat(1000)}TAIL`);
    const page = await activities.readPage(last.id, {
      firstSourceId: first.id,
      offset: 0,
      limit: 50,
      maxBytes: 10000,
      tail: true,
    });
    expect(page?.text).toMatch(/^12:05 /);
    expect(page?.text).toContain('TAIL');
    expect(page?.text).not.toContain('HEAD');
    expect(page?.text.length).toBeLessThanOrEqual(50);
    expect(page?.nextOffset).toBeNull();
    for (const limit of [0, 1, 5, 6]) {
      const tiny = await activities.readPage(last.id, {
        offset: 0,
        limit,
        maxBytes: 10000,
        tail: true,
      });
      expect(tiny?.text.length).toBeLessThanOrEqual(limit);
    }
  });

  it('resolves the newest history entry for the given message ids', async () => {
    const { activities } = await setup();
    expect(await activities.resolveBoundary(['no-such-message'])).toBeNull();
  });

  it('includes separators in the rendered size budget', async () => {
    const { activities, append, now } = await setup();
    const first = await append('first');
    await append('second');
    const pages = await Promise.all(
      (await activities.manifest()).map((ref) =>
        activities.readPage(ref.id, {
          offset: 0,
          limit: 1000,
          maxBytes: 10000,
        }),
      ),
    );
    // The second source shares its time with the first; omit its six-character prefix.
    // Leave exactly the combined record lengths, but no room for the separator.
    const maxCharacters = pages.reduce(
      (sum, page) => sum + (page?.text.length ?? 0),
      -6,
    );
    const batch = await activities.readPending(null, {
      ...ready(now()),
      maxCharacters,
    });
    expect(batch?.id).toBe(first.id);
    expect(batch?.text.length).toBeLessThanOrEqual(maxCharacters);
  });

  it('returns partial search progress and byte charges when a later page fails', async () => {
    const { activities, append } = await setup();
    await append('first evidence');
    const first = await append('second evidence');
    const original = activities.readPage.bind(activities);
    const readPage = vi.spyOn(activities, 'readPage');
    readPage
      .mockImplementationOnce(original)
      .mockRejectedValueOnce(new Error('SQLite read failed'));
    const result = await activities.search('evidence', {
      offset: 0,
      limit: 5,
      maxBytes: 10000,
    });
    expect(result).toMatchObject({
      scannedBytes: first.bytes,
      nextOffset: 1,
      truncated: true,
    });
    expect(result.matches.map((match) => match.id)).toEqual([first.id]);
    readPage.mockRestore();
  });

  it('reconstructs a bounded batch range rather than just the final source', async () => {
    const { activities, append, now } = await setup();
    const first = await append('earlier evidence');
    const last = await append('final evidence');
    const batch = await activities.readPending(null, ready(now() + 600_000));
    expect(batch?.firstSourceId).toBe(first.id);
    const retry = await activities.readPage(last.id, {
      firstSourceId: first.id,
      offset: 0,
      limit: 128000,
      maxBytes: 2000000,
      tail: true,
    });
    expect(retry?.text).toBe(batch?.text);
    expect(retry?.sourceIds).toEqual([first.id, last.id]);
  });

  it('splits on elapsed duration within the same UTC date', async () => {
    const { activities, append, setTime, now } = await setup();
    const first = await append('before duration boundary');
    setTime('2026-10-01T12:31:00Z');
    await append('after duration boundary');
    const batch = await activities.readPending(null, ready(now()));
    expect(batch?.id).toBe(first.id);
    expect(batch?.text).not.toContain('after duration boundary');
  });

  it('advances through filtered-only pages without losing the next visible source', async () => {
    const { activities, sync, now } = await setup();
    const hidden: ExtendedUIMessage[] = Array.from(
      { length: 205 },
      (_, index) => ({
        id: `hidden-${index}`,
        role: 'user',
        parts: [{ type: 'text', text: 'excluded raw user text' }],
      }),
    );
    await sync([
      ...hidden,
      {
        id: 'visible',
        role: 'assistant',
        parts: [{ type: 'text', text: 'visible after filtered page' }],
      },
    ]);
    const first = await activities.readPending(null, ready(now() + 600_000));
    expect(first?.text).toBe('');
    expect(first?.recordCount).toBe(0);
    expect(activityOrdinal(first?.id ?? null)).toBe(199);
    const next = await activities.readPending(
      first?.id ?? null,
      ready(now() + 600_000),
    );
    expect(next?.text).toContain('visible after filtered page');
    expect(activityOrdinal(next?.id ?? null)).toBe(205);
    expect(
      await activities.readPending(next?.id ?? null, ready(now() + 600_000)),
    ).toBeNull();
  });

  it('applies changed readiness settings without a persisted grouping catalogue', async () => {
    const { activities, append, now } = await setup();
    await append('configuration changes affect pending activity');
    expect(await activities.readPending(null, ready(now() + 1_000))).toBeNull();
    const batch = await activities.readPending(null, {
      ...ready(now() + 1_000),
      idleTimeoutMs: 500,
    });
    expect(batch?.text).toContain('configuration changes');
  });

  it('reports missing and oversized evidence without replaying an absent cursor', async () => {
    const { activities, append, sync, now } = await setup();
    const source = await append('rolled back');
    await sync([]);
    expect(
      await activities.readPage(source.id, {
        offset: 0,
        limit: 1000,
        maxBytes: 10000,
      }),
    ).toBeNull();
    expect(
      await activities.readPending(source.id, ready(now() + 600_000)),
    ).toBeNull();
    const large = await append('x'.repeat(10000));
    const page = await activities.readPage(large.id, {
      offset: 0,
      limit: 1000,
      maxBytes: 10,
    });
    expect(page).toMatchObject({ text: '', truncated: true });
  });

  it('reads head/tail and literal search with bounded output and source handles', async () => {
    const { activities, append } = await setup();
    const source = await append('canonical SQLite activity evidence');
    const head = await activities.readPage(source.id, {
      offset: 0,
      limit: 10,
      maxBytes: 10000,
    });
    const tail = await activities.readPage(source.id, {
      offset: 0,
      limit: 10,
      maxBytes: 10000,
      tail: true,
    });
    expect(head?.nextOffset).toBe(10);
    expect(tail?.text).toBe('12:00 ence');
    expect(tail?.text.length).toBeLessThanOrEqual(10);
    expect(
      (
        await activities.search('SQLite', {
          offset: 0,
          maxBytes: 10000,
          limit: 1,
        })
      ).matches[0]?.id,
    ).toBe(source.id);
    expect(activityOrdinal(source.id)).toBe(0);
    expect(activityOrdinal('2026-10-01/0001')).toBeNull();
  });
});
