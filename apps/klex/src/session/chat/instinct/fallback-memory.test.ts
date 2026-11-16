import { describe, expect, it } from 'vitest';

import { createInstinctFallbackMemory } from './fallback-memory';

const IDLE = 600_000;

describe('instinct fallback memory', () => {
  it('starts with the first candidate', () => {
    expect(createInstinctFallbackMemory().start('a|b', IDLE, 0)).toBe(0);
  });

  it('keeps the last working candidate while active', () => {
    const memory = createInstinctFallbackMemory();
    memory.start('a|b', IDLE, 0);
    memory.succeeded('a|b', 1);
    expect(memory.start('a|b', IDLE, IDLE)).toBe(1);
  });

  it('retries the first candidate after the idle window', () => {
    const memory = createInstinctFallbackMemory();
    memory.start('a|b', IDLE, 0);
    memory.succeeded('a|b', 1);
    expect(memory.start('a|b', IDLE, IDLE + 1)).toBe(0);
  });

  it('resets when the candidate list changes', () => {
    const memory = createInstinctFallbackMemory();
    memory.start('a|b', IDLE, 0);
    memory.succeeded('a|b', 1);
    expect(memory.start('a|c', IDLE, 1)).toBe(0);
  });
});
