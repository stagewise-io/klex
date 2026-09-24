import { describe, expect, it } from 'vitest';

import { fitPrefix, fitPrefixWithOmission } from './fit';

const joinedLength = (prefix: readonly string[]) => prefix.join(',').length;

describe('fitPrefix', () => {
  it('keeps the longest fitting prefix', () => {
    expect(fitPrefix(['aa', 'bb', 'cc'], joinedLength, 5)).toEqual([
      'aa',
      'bb',
    ]);
  });

  it('stops at the first candidate that does not fit', () => {
    expect(fitPrefix(['aa', 'bbbbbb', 'c'], joinedLength, 5)).toEqual(['aa']);
  });

  it('returns everything or nothing at the extremes', () => {
    expect(fitPrefix(['a', 'b'], joinedLength, 100)).toEqual(['a', 'b']);
    expect(fitPrefix(['aaa'], joinedLength, 2)).toEqual([]);
    expect(fitPrefix([], joinedLength, 0)).toEqual([]);
  });

  it('measures the whole prefix', () => {
    const measured: string[][] = [];
    fitPrefix(
      ['a', 'b'],
      (prefix) => {
        measured.push([...prefix]);
        return 0;
      },
      0,
    );
    expect(measured).toEqual([['a'], ['a', 'b']]);
  });
});

describe('fitPrefixWithOmission', () => {
  const annotate = (last: string, omitted: number) => `${last}+${omitted}`;

  it('does not annotate when everything fits', () => {
    expect(
      fitPrefixWithOmission(['a', 'b'], joinedLength, 10, annotate),
    ).toEqual(['a', 'b']);
  });

  it('annotates the last kept entry with the omitted count', () => {
    expect(
      fitPrefixWithOmission(['a', 'b', 'cccccc'], joinedLength, 7, annotate),
    ).toEqual(['a', 'b+1']);
  });

  it('drops entries until the annotation fits and recounts omissions', () => {
    // 'a,b' fits in 3, 'a,b+1' does not, 'a+2' does.
    expect(
      fitPrefixWithOmission(['a', 'b', 'cccccc'], joinedLength, 3, annotate),
    ).toEqual(['a+2']);
  });

  it('returns nothing when no annotated entry fits', () => {
    expect(
      fitPrefixWithOmission(['a', 'bbbbbb'], joinedLength, 2, annotate),
    ).toEqual([]);
  });
});
