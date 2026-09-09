import { describe, expect, it } from 'vitest';

import { terminalSize } from './use-terminal-size';

describe('terminalSize', () => {
  it('uses the standard fallback dimensions', () => {
    expect(terminalSize({})).toEqual({ width: 80, height: 24 });
    expect(terminalSize({ columns: 0, rows: 0 })).toEqual({
      width: 80,
      height: 24,
    });
  });

  it('uses supplied terminal dimensions', () => {
    expect(terminalSize({ columns: 120, rows: 42 })).toEqual({
      width: 120,
      height: 42,
    });
  });
});
