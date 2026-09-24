import { describe, expect, it } from 'vitest';

import {
  compactJson,
  keyValueLines,
  serializeValue,
  truncateText,
} from './truncate';

describe('keyValueLines', () => {
  it('flattens objects to dotted key-value lines', () => {
    expect(
      keyValueLines({
        id: 'chat-42',
        count: 2,
        ok: true,
        none: null,
        skip: undefined,
        tags: ['a', 'b'],
        user: { name: 'Ada', roles: [] },
        list: [{ x: 1 }],
      }),
    ).toBe(
      [
        'id: chat-42',
        'count: 2',
        'ok: true',
        'none: null',
        'tags: a, b',
        'user.name: Ada',
        'user.roles: []',
        'list.0.x: 1',
      ].join('\n'),
    );
  });

  it('falls back to compact JSON below the depth limit', () => {
    expect(keyValueLines({ a: { b: { c: { d: 1 } } } })).toBe('a.b.c: {"d":1}');
  });

  it('stops after the node limit', () => {
    const many = Object.fromEntries(
      Array.from({ length: 300 }, (_, index) => [`k${index}`, index]),
    );

    expect(keyValueLines(many).split('\n').at(-1)).toBe('…');
  });

  it('handles scalars, empty objects, and cycles', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;

    expect(keyValueLines(7)).toBe('7');
    expect(keyValueLines({})).toBe('');
    expect(keyValueLines(['x', 'y'])).toBe('x, y');
    expect(keyValueLines(cyclic)).toBe('a: 1\nself: [Circular]');
  });

  it('treats empty output as nothing in serializeValue', () => {
    expect(
      serializeValue({}, { max: 10, truncate: 'end', json: 'lines' }),
    ).toBeNull();
  });
});

describe('truncateText', () => {
  it.each([
    ['end', 'abcd…'],
    ['middle', 'ab…ij'],
    ['end-overflow', 'abcde…'],
  ] as const)('%s', (truncate, expected) => {
    expect(truncateText('abcdefghij', { max: 5, truncate })).toBe(expected);
  });

  it.each(['end', 'middle', 'end-overflow'] as const)(
    'keeps text at the limit unchanged (%s)',
    (truncate) => {
      expect(truncateText('abcde', { max: 5, truncate })).toBe('abcde');
      expect(truncateText('', { max: 0, truncate })).toBe('');
    },
  );

  it.each([
    ['end', 0, ''],
    ['end', 1, '…'],
    ['end', 2, 'a…'],
    ['middle', 0, ''],
    ['middle', 1, '…'],
    ['middle', 2, 'a…'],
    ['middle', 3, 'a…j'],
    ['middle', 4, 'ab…j'],
    ['end-overflow', 0, '…'],
    ['end-overflow', 1, 'a…'],
    ['end', -3, ''],
    ['end', 2.9, 'a…'],
  ] as const)('%s with max %s', (truncate, max, expected) => {
    expect(truncateText('abcdefghij', { max, truncate })).toBe(expected);
  });

  it('never exceeds the limit for length-bounded styles', () => {
    for (let max = 0; max <= 12; max++) {
      for (const truncate of ['end', 'middle'] as const) {
        expect(
          truncateText('abcdefghij', { max, truncate }).length,
        ).toBeLessThanOrEqual(Math.max(max, 0));
      }
    }
  });
});

describe('serializeValue', () => {
  const plain = { max: 10, truncate: 'end', json: 'plain' } as const;
  const compact = { max: 10, truncate: 'end', json: 'compact' } as const;

  it('keeps strings verbatim and truncates them', () => {
    expect(serializeValue('hello', plain)).toBe('hello');
    expect(serializeValue('hello world!', plain)).toBe('hello wor…');
  });

  it('stringifies non-string values', () => {
    expect(serializeValue({ a: 1 }, plain)).toBe('{"a":1}');
    expect(serializeValue(42, compact)).toBe('42');
  });

  it('returns null for undefined in both modes', () => {
    expect(serializeValue(undefined, plain)).toBeNull();
    expect(serializeValue(undefined, compact)).toBeNull();
  });

  it('treats empty strings as nothing only in plain mode', () => {
    expect(serializeValue('', plain)).toBeNull();
    expect(serializeValue('', compact)).toBe('');
  });

  it('returns null for plain values JSON cannot represent', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(serializeValue(circular, plain)).toBeNull();
    expect(serializeValue(() => 1, plain)).toBeNull();
  });

  it('falls back to compact markers instead of failing', () => {
    expect(serializeValue(10n, compact)).toBe('[unserial…');
  });
});

describe('compactJson', () => {
  it('marks undefined and circular references', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(compactJson(undefined)).toBe('[undefined]');
    expect(compactJson(() => 1)).toBe('[undefined]');
    expect(compactJson(circular)).toBe('{"a":1,"self":"[Circular]"}');
  });

  it('bounds string length at the top level and when nested', () => {
    const long = 'x'.repeat(1_000);
    expect(compactJson(long)).toBe(JSON.stringify('x'.repeat(600)));
    expect(compactJson({ long })).toBe(
      JSON.stringify({ long: 'x'.repeat(600) }),
    );
  });

  it('gives up on values with too many nodes', () => {
    expect(compactJson(Array.from({ length: 500 }, (_, i) => i))).toBe(
      '[unserializable]',
    );
    expect(compactJson(Array.from({ length: 100 }, (_, i) => i))).toBe(
      JSON.stringify(Array.from({ length: 100 }, (_, i) => i)),
    );
  });

  it('never throws on unserializable values', () => {
    expect(compactJson({ big: 1n })).toBe('[unserializable]');
  });
});
