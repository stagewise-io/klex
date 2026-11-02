import { afterEach, describe, expect, it } from 'vitest';

import type { ExtendedUIMessage } from '@/session/chat/message-types';

import { activityOrdinal } from './activity-history';
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
    const first = await append('first bounded record');
    await append('second bounded record');
    const batch = await activities.readPending(null, {
      ...ready(now()),
      maxCharacters: 40,
    });
    expect(batch?.id).toBe(first.id);
    expect(batch?.text).toContain('first bounded record');
    expect(batch?.text).not.toContain('second bounded record');
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
    expect(tail?.text).toBe('y evidence');
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
