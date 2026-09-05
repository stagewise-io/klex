export interface MessageComposerState {
  value: string;
  cursorOffset: number;
}

function previousCodePointOffset(value: string, cursorOffset: number): number {
  const offset = Math.min(Math.max(0, cursorOffset), value.length);
  if (offset < 2) return Math.max(0, offset - 1);

  const previous = value.charCodeAt(offset - 1);
  const beforePrevious = value.charCodeAt(offset - 2);
  const isSurrogatePair =
    previous >= 0xdc00 &&
    previous <= 0xdfff &&
    beforePrevious >= 0xd800 &&
    beforePrevious <= 0xdbff;
  return offset - (isSurrogatePair ? 2 : 1);
}

function nextCodePointOffset(value: string, cursorOffset: number): number {
  const offset = Math.min(Math.max(0, cursorOffset), value.length);
  if (offset >= value.length) return value.length;

  const current = value.charCodeAt(offset);
  const next = value.charCodeAt(offset + 1);
  const isSurrogatePair =
    current >= 0xd800 && current <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
  return offset + (isSurrogatePair ? 2 : 1);
}

export function moveComposerCursor(
  state: MessageComposerState,
  direction: 'left' | 'right',
): MessageComposerState {
  return {
    ...state,
    cursorOffset:
      direction === 'left'
        ? previousCodePointOffset(state.value, state.cursorOffset)
        : nextCodePointOffset(state.value, state.cursorOffset),
  };
}

export function deleteComposerText(
  state: MessageComposerState,
  direction: 'backward' | 'forward',
): MessageComposerState {
  const cursorOffset = Math.min(
    Math.max(0, state.cursorOffset),
    state.value.length,
  );
  const start =
    direction === 'backward'
      ? previousCodePointOffset(state.value, cursorOffset)
      : cursorOffset;
  const end =
    direction === 'backward'
      ? cursorOffset
      : nextCodePointOffset(state.value, cursorOffset);
  return {
    value: state.value.slice(0, start) + state.value.slice(end),
    cursorOffset: start,
  };
}

export function insertComposerText(
  state: MessageComposerState,
  text: string,
): MessageComposerState {
  const cursorOffset = Math.min(
    Math.max(0, state.cursorOffset),
    state.value.length,
  );
  return {
    value:
      state.value.slice(0, cursorOffset) +
      text +
      state.value.slice(cursorOffset),
    cursorOffset: cursorOffset + text.length,
  };
}
