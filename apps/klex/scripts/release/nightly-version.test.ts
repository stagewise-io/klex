import { describe, expect, it } from 'vitest';

import { createNightlyVersion, formatNightlyDate } from './nightly-version';

describe('nightly release version', () => {
  it('increments the stable patch and starts the daily counter', () => {
    expect(
      createNightlyVersion({
        date: '20260902',
        packageVersion: '1.2.3',
        tags: [],
      }),
    ).toEqual({
      tag: 'v1.2.4-nightly20260902c001',
      version: '1.2.4-nightly20260902c001',
    });
  });

  it('increments the largest matching counter only', () => {
    expect(
      createNightlyVersion({
        date: '20260902',
        packageVersion: '1.2.3',
        tags: [
          'v1.2.4-nightly20260902c002',
          'v1.2.4-nightly20260902c010',
          'v1.2.4-nightly20260901c099',
          'v9.9.9-nightly20260902c999',
        ],
      }).version,
    ).toBe('1.2.4-nightly20260902c011');
  });

  it('uses an explicit valid counter', () => {
    expect(
      createNightlyVersion({
        counter: 7,
        date: '20260902',
        packageVersion: '0.0.0',
        tags: [],
      }).version,
    ).toBe('0.0.1-nightly20260902c007');
  });

  it.each(['1.2.3-beta.1', 'v1.2.3', '01.2.3'])(
    'rejects non-stable package version %s',
    (packageVersion) => {
      expect(() =>
        createNightlyVersion({
          date: '20260902',
          packageVersion,
          tags: [],
        }),
      ).toThrow('Invalid stable Klex package version');
    },
  );

  it.each(['20260230', '20261301', '2026092'])('rejects date %s', (date) => {
    expect(() =>
      createNightlyVersion({ packageVersion: '1.2.3', date, tags: [] }),
    ).toThrow('Invalid nightly date');
  });

  it.each([0, 1_000, 1.5])('rejects counter %s', (counter) => {
    expect(() =>
      createNightlyVersion({
        counter,
        date: '20260902',
        packageVersion: '1.2.3',
        tags: [],
      }),
    ).toThrow('Nightly counter must be an integer between 1 and 999');
  });

  it('formats dates in UTC', () => {
    expect(formatNightlyDate(new Date('2026-09-02T23:59:59Z'))).toBe(
      '20260902',
    );
  });
});
