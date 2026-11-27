import { describe, expect, it } from 'vitest';

import { formatCode, isCompleteCode } from './code.ts';

describe('formatCode', () => {
  it('groups pasted codes and upper-cases them', () => {
    expect(formatCode(' abcd efgh jkmn ')).toBe('ABCD-EFGH-JKMN');
    expect(formatCode('ABCD-EFGH-JKMN')).toBe('ABCD-EFGH-JKMN');
    expect(formatCode('abcdefghjkmnpq')).toBe('ABCD-EFGH-JKMN');
  });

  it('drops characters Cloud never uses', () => {
    expect(formatCode('AB0O-1I')).toBe('AB');
    expect(formatCode('abc')).toBe('ABC');
    expect(formatCode('abcde')).toBe('ABCD-E');
  });
});

describe('isCompleteCode', () => {
  it('accepts only the full format', () => {
    expect(isCompleteCode('ABCD-EFGH-JKMN')).toBe(true);
    expect(isCompleteCode('ABCD-EFGH-JKM')).toBe(false);
    expect(isCompleteCode('ABCD-EFGH-JKM0')).toBe(false);
  });
});
