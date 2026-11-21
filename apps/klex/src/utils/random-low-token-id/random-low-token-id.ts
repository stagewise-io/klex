import { createHash, randomInt, randomUUID } from 'node:crypto';

import dictionary from './dictionary.md';

const words = dictionary
  .split(/\r?\n/)
  .map((word) => word.trim())
  .filter(Boolean);
const wordSet = new Set(words);

export const LOW_TOKEN_ID_MIN_LENGTH =
  Math.min(...words.map((word) => word.length)) * 3;
export const LOW_TOKEN_ID_MAX_LENGTH =
  Math.max(...words.map((word) => word.length)) * 3;

const capitalize = (word: string) =>
  word.charAt(0).toUpperCase() + word.slice(1);

/** Capitalized random dictionary words, concatenated (default: three). Callers must check uniqueness. */
export function randomLowTokenID(wordCount = 3): string {
  if (!Number.isSafeInteger(wordCount) || wordCount < 1)
    throw new RangeError('wordCount must be a positive safe integer');
  return Array.from({ length: wordCount }, () => {
    return capitalize(words[randomInt(words.length)]!);
  }).join('');
}

/** Three capitalized dictionary words derived from `seed` (default: a random UUID). */
export function seededLowTokenID(seed: string = randomUUID()): string {
  const digest = createHash('sha256').update(seed).digest();
  return Array.from({ length: 3 }, (_, index) =>
    capitalize(words[digest.readUInt32BE(index * 4) % words.length]!),
  ).join('');
}

/**
 * True when `id` is capitalized words that are all in the current dictionary.
 * Lowercase concatenations are never accepted: without word boundaries a
 * removed word can hide inside another valid segmentation.
 */
export function isDictionaryLowTokenID(id: string): boolean {
  return (
    /^(?:[A-Z][a-z]+)+$/.test(id) &&
    id.match(/[A-Z][a-z]+/g)!.every((word) => wordSet.has(word.toLowerCase()))
  );
}
