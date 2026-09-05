import { describe, expect, it } from 'vitest';

import { formatAge } from './format-age';

describe('formatAge', () => {
  const now = Date.parse('2026-01-02T00:00:00.000Z');

  it.each([
    [30_000, '30s'],
    [120_000, '2m'],
    [7_200_000, '2h'],
    [86_400_000, '1d'],
  ])('formats an elapsed duration of %i milliseconds', (elapsed, expected) => {
    expect(formatAge(new Date(now - elapsed).toISOString(), now)).toBe(
      expected,
    );
  });

  it('returns unknown for invalid dates', () => {
    expect(formatAge('not-a-date', now)).toBe('unknown');
  });

  it('clamps future dates to zero seconds', () => {
    expect(formatAge(new Date(now + 60_000).toISOString(), now)).toBe('0s');
  });
});
