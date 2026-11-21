import { randomInt } from 'node:crypto';

import { getEncoding } from 'js-tiktoken';
import { afterEach, describe, expect, it, vi } from 'vitest';

import dictionary from './dictionary.md';
import {
  isDictionaryLowTokenID,
  LOW_TOKEN_ID_MAX_LENGTH,
  LOW_TOKEN_ID_MIN_LENGTH,
  randomLowTokenID,
  seededLowTokenID,
} from './random-low-token-id';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomInt: vi.fn(actual.randomInt) };
});

afterEach(() => vi.mocked(randomInt).mockReset());

const words = dictionary
  .split(/\r?\n/)
  .map((word) => word.trim())
  .filter(Boolean);

describe('randomLowTokenID', () => {
  it('uses all 9,523 dictionary words without filtering or duplicates', () => {
    expect(words).toHaveLength(9_523);
    expect(new Set(words).size).toBe(words.length);
    expect(words.every((word) => /^[a-z]{2,}$/.test(word))).toBe(true);
    expect(LOW_TOKEN_ID_MIN_LENGTH).toBe(
      Math.min(...words.map((word) => word.length)) * 3,
    );
    expect(LOW_TOKEN_ID_MAX_LENGTH).toBe(
      Math.max(...words.map((word) => word.length)) * 3,
    );
  });

  it('capitalizes and concatenates exactly three independently selected words without separators', () => {
    const random = vi.mocked(randomInt as (max: number) => number);
    random
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(words.length - 1);
    expect(randomLowTokenID()).toBe(
      [words[0]!, words[1]!, words.at(-1)!]
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(''),
    );
    expect(random).toHaveBeenCalledTimes(3);
    expect(random).toHaveBeenNthCalledWith(1, words.length);
    expect(random).toHaveBeenNthCalledWith(2, words.length);
    expect(random).toHaveBeenNthCalledWith(3, words.length);
  });

  it.each([1, 2, 3, 5])(
    'generates %i capitalized words when configured',
    (wordCount) => {
      const random = vi.mocked(randomInt as (max: number) => number);
      random.mockReturnValue(0);
      expect(randomLowTokenID(wordCount)).toBe('The'.repeat(wordCount));
      expect(random).toHaveBeenCalledTimes(wordCount);
    },
  );

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid word count %s',
    (wordCount) => {
      expect(() => randomLowTokenID(wordCount)).toThrow(RangeError);
      expect(randomInt).not.toHaveBeenCalled();
    },
  );

  it('derives seeded IDs from the seed, or a random UUID without one', () => {
    const id = seededLowTokenID('DamnSlaveGod');
    expect(id).toBe(seededLowTokenID('DamnSlaveGod'));
    expect(seededLowTokenID()).not.toBe(seededLowTokenID());
    expect(id).toMatch(/^(?:[A-Z][a-z]+){3}$/);
    expect(isDictionaryLowTokenID(id)).toBe(true);
    expect(randomInt).not.toHaveBeenCalled();
  });

  it('recognizes IDs made only of current dictionary words', () => {
    const [a, b, c] = [words[0]!, words[1]!, words.at(-1)!];
    const cap = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
    expect(isDictionaryLowTokenID([a, b, c].map(cap).join(''))).toBe(true);
    expect(isDictionaryLowTokenID(`${cap(a)}Damn${cap(c)}`)).toBe(false);
    // Lowercase concatenations cannot be segmented reliably.
    expect(isDictionaryLowTokenID(`${a}${b}${c}`)).toBe(false);
  });

  it('measures concatenated dictionary ID token costs against UUIDs', () => {
    for (const name of ['cl100k_base', 'o200k_base'] as const) {
      const encoding = getEncoding(name);
      let wordTokens = 0;
      let uuidTokens = 0;
      for (let index = 0; index < 1000; index++) {
        const id = [index * 7, index * 17 + 1, index * 31 + 2]
          .map((at) => {
            const word = words[at % words.length]!;
            return word.charAt(0).toUpperCase() + word.slice(1);
          })
          .join('');
        wordTokens += encoding.encode(id).length;
        uuidTokens += encoding.encode(
          `f47ac10b-58cc-4372-a567-${index.toString(16).padStart(12, '0')}`,
        ).length;
      }
      expect(wordTokens).toBeLessThan(uuidTokens);
    }
  });
});
