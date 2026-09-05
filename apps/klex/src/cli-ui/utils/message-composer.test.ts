import { describe, expect, it } from 'vitest';

import { insertComposerText } from './message-composer';

describe('insertComposerText', () => {
  it('inserts text at the cursor and advances it', () => {
    expect(
      insertComposerText({ value: 'firstsecond', cursorOffset: 5 }, ' '),
    ).toEqual({ value: 'first second', cursorOffset: 6 });
  });

  it('supports a new line for Shift+Enter composition', () => {
    expect(
      insertComposerText({ value: 'FirstSecond', cursorOffset: 5 }, '\n'),
    ).toEqual({ value: 'First\nSecond', cursorOffset: 6 });
  });

  it('clamps an out-of-bounds cursor', () => {
    expect(
      insertComposerText({ value: 'text', cursorOffset: 99 }, '!'),
    ).toEqual({ value: 'text!', cursorOffset: 5 });
  });
});
