import { randomInt } from 'node:crypto';

import dictionary from './dictionary.md';

const words = dictionary
  .split(/\r?\n/)
  .map((word) => word.trim())
  .filter(Boolean);

export const LOW_TOKEN_ID_MIN_LENGTH =
  Math.min(...words.map((word) => word.length)) * 3;
export const LOW_TOKEN_ID_MAX_LENGTH =
  Math.max(...words.map((word) => word.length)) * 3;

/** Capitalized random dictionary words, concatenated (default: three). Callers must check uniqueness. */
export function randomLowTokenID(wordCount = 3): string {
  if (!Number.isSafeInteger(wordCount) || wordCount < 1)
    throw new RangeError('wordCount must be a positive safe integer');
  return Array.from({ length: wordCount }, () => {
    const word = words[randomInt(words.length)]!;
    return word.charAt(0).toUpperCase() + word.slice(1);
  }).join('');
}
