import { describe, expect, it } from 'vitest';

import {
  assertJsonValue,
  assertSerializedSize,
  SerializationError,
} from './serialization';

describe('toolbox serialization', () => {
  it('accepts nested JSON values', () => {
    expect(() =>
      assertJsonValue({ value: [true, null, 1, 'x'] }),
    ).not.toThrow();
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    1n,
    Symbol('x'),
    () => undefined,
  ])('rejects unsupported value %s', (value) =>
    expect(() => assertJsonValue(value)).toThrow(SerializationError),
  );

  it('rejects cyclic and prototype-bearing values', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => assertJsonValue(cyclic)).toThrow(/cycle/);
    expect(() => assertJsonValue(new Date())).toThrow(/plain object/);
  });

  it('enforces UTF-8 byte limits', () => {
    expect(() => assertSerializedSize('é', 4, 'Value')).not.toThrow();
    expect(() => assertSerializedSize('é', 3, 'Value')).toThrow(/exceeds/);
  });
});
