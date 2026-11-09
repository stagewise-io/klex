import { afterEach, describe, expect, it, vi } from 'vitest';

import { createActivityFixture } from '@/activity-history/test-support';

import { ActivityEntryStore } from './activity-reader';

const fixtures: Awaited<ReturnType<typeof createActivityFixture>>[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

describe('activity reader neighbors', () => {
  it.each([
    { before: 0, after: 0, expected: [5] },
    { before: 0, after: 5, expected: [5, 6, 7, 8, 9, 10] },
    { before: 2, after: 4, expected: [3, 4, 5, 6, 7, 8, 9] },
  ])(
    'honors $before prior and $after following neighbors chronologically',
    async ({ before, after, expected }) => {
      const fixture = await createActivityFixture();
      fixtures.push(fixture);
      const refs: Awaited<ReturnType<typeof fixture.append>>[] = [];
      for (let i = 0; i < 11; i++)
        refs.push(await fixture.append(`message ${i}`));
      const center = refs[5];
      if (!center) throw new Error('Missing center fixture');
      const original = fixture.activities.listNeighbors.bind(
        fixture.activities,
      );
      // SQLite returns chronological rows; also tolerate newest-first providers.
      vi.spyOn(fixture.activities, 'listNeighbors').mockImplementation(
        async (...args) => (await original(...args)).reverse(),
      );
      const reader = new ActivityEntryStore(fixture.activities);
      const [location] = await reader.read(center.id);
      if (!location) throw new Error('Missing center evidence');
      const pages = await reader.readNeighbors(location, before, after);
      expect(pages.map((page) => page.sourceId)).toEqual(
        expected.map((index) => refs[index]?.id),
      );
    },
  );
});
