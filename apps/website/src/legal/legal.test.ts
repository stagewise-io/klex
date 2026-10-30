import { describe, expect, it } from 'vitest';

import { fixtureCatalog } from './fixtures';
import {
  boundaryDelay,
  date,
  revisionState,
  safeLink,
  selectEffective,
  validateCatalog,
} from './legal';

const catalog = fixtureCatalog();
const revisions = catalog.policies.privacy;

describe('static legal catalog and UTC selection', () => {
  it('selects nothing before the first date, then switches at exact UTC midnight', () => {
    expect(
      selectEffective(revisions, new Date('2018-12-31T23:59:59.999Z')),
    ).toBeUndefined();
    expect(
      selectEffective(revisions, new Date('2020-12-31T23:59:59.999Z'))
        ?.revision,
    ).toBe('2020-01-01');
    expect(
      selectEffective(revisions, new Date('2021-01-01T00:00:00.000Z'))
        ?.revision,
    ).toBe('2021-01-01');
    expect(
      selectEffective(revisions, new Date('2020-12-31T19:00:00-05:00'))
        ?.revision,
    ).toBe('2021-01-01');
    expect(selectEffective([], new Date())).toBeUndefined();
  });
  it('distinguishes current, historical and upcoming and limits the current predecessor', () => {
    const now = new Date('2021-05-01T00:00:00Z');
    expect(revisionState(revisions, revisions[1], now)).toMatchObject({
      status: 'current',
      earlier: [revisions[2]],
    });
    expect(revisionState(revisions, revisions[2], now)).toMatchObject({
      status: 'historical',
      earlier: [revisions[3]],
    });
    expect(revisionState(revisions, revisions[0], now)).toMatchObject({
      status: 'upcoming',
      earlier: revisions.slice(1),
    });
  });
  it('schedules at the next boundary, bounded to a day', () => {
    expect(boundaryDelay(revisions, new Date('2020-12-31T23:59:59.999Z'))).toBe(
      1,
    );
    expect(boundaryDelay(revisions, new Date('2020-12-01T00:00:00Z'))).toBe(
      86400000,
    );
    expect(boundaryDelay([], new Date())).toBe(86400000);
  });
  it.each(['2021-02-29', '2020-13-01', '2020-1-01', '2020-01-01T00:00:00Z'])(
    'rejects malformed calendar dates: %s',
    (value) => expect(() => date(value)).toThrow(),
  );
  it('allows valid leap dates and empty policy arrays', () => {
    expect(date('2020-02-29')).toBe('2020-02-29');
    expect(validateCatalog(catalog).policies.terms).toEqual([]);
  });
  it('preserves boolean consent flags through validation and effective-date selection', () => {
    const value = structuredClone(catalog);
    value.policies.privacy[1].requiresConsent = true;
    const validated = validateCatalog(value);
    expect(
      selectEffective(validated.policies.privacy, new Date('2021-01-01'))
        ?.requiresConsent,
    ).toBe(true);
    expect(
      selectEffective(validated.policies.privacy, new Date('2020-01-01'))
        ?.requiresConsent,
    ).toBe(false);
  });
  it.each([undefined, null, 'true', 'false', 0, 1, [], {}])(
    'rejects missing or nonboolean catalog requiresConsent: %s',
    (requiresConsent) => {
      const value = structuredClone(catalog);
      Object.assign(value.policies.privacy[0], { requiresConsent });
      if (requiresConsent === undefined)
        Reflect.deleteProperty(value.policies.privacy[0], 'requiresConsent');
      expect(() => validateCatalog(value)).toThrow();
    },
  );
  it.each([
    (value: typeof catalog) => {
      value.schemaVersion = 0 as 1;
    },
    (value: typeof catalog) => {
      value.policies.privacy.reverse();
    },
    (value: typeof catalog) => {
      value.policies.privacy.push(value.policies.privacy[0]);
    },
    (value: typeof catalog) => {
      value.policies.privacy[0].effectiveDate = '2098-01-01';
    },
    (value: typeof catalog) => {
      value.policies.privacy[0].url =
        'https://evil.invalid/legal/privacy/2099-01-01';
    },
    (value: typeof catalog) => {
      value.policies.privacy[0].url = 'https://klex.bot/legal/privacy';
    },
    (value: typeof catalog) => {
      value.policies.privacy[0].markdownUrl += '?x=1';
    },
    (value: typeof catalog) => {
      value.policies.privacy[0].sha256 = 'F'.repeat(64);
    },
    (value: typeof catalog) => {
      Object.defineProperty(value.policies, 'constructor', {
        value: [],
        enumerable: true,
      });
    },
  ])(
    'rejects malformed records, ordering, reserved identities and URLs',
    (mutate) => {
      const value = structuredClone(catalog);
      mutate(value);
      expect(() => validateCatalog(value)).toThrow();
    },
  );
  it.each([
    'javascript:alert(1)',
    'data:text/html,hi',
    '//evil.invalid',
    'https:\\evil.invalid',
    ' javaScript:alert(1)',
  ])('rejects executable/ambiguous links: %s', (link) =>
    expect(safeLink(link)).toBe(false),
  );
  it.each([
    '/legal/privacy',
    '#section-scope',
    'https://example.invalid',
    'mailto:legal@example.invalid',
  ])('permits safe explicit links: %s', (link) =>
    expect(safeLink(link)).toBe(true),
  );
});
