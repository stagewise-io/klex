export interface MessageComposerState {
  value: string;
  cursorOffset: number;
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
