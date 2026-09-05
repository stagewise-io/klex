import { describe, expect, it } from 'vitest';

import {
  deleteComposerText,
  insertComposerText,
  moveComposerCursor,
} from './message-composer';

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

  it('moves across non-BMP characters without entering surrogate pairs', () => {
    expect(
      moveComposerCursor({ value: 'a😀b', cursorOffset: 3 }, 'left'),
    ).toEqual({ value: 'a😀b', cursorOffset: 1 });
    expect(
      moveComposerCursor({ value: 'a😀b', cursorOffset: 1 }, 'right'),
    ).toEqual({ value: 'a😀b', cursorOffset: 3 });
  });

  it('deletes complete non-BMP characters', () => {
    expect(
      deleteComposerText({ value: 'a😀b', cursorOffset: 3 }, 'backward'),
    ).toEqual({ value: 'ab', cursorOffset: 1 });
    expect(
      deleteComposerText({ value: 'a😀b', cursorOffset: 1 }, 'forward'),
    ).toEqual({ value: 'ab', cursorOffset: 1 });
  });

  it('clamps an out-of-bounds cursor', () => {
    expect(
      insertComposerText({ value: 'text', cursorOffset: 99 }, '!'),
    ).toEqual({ value: 'text!', cursorOffset: 5 });
  });
});
