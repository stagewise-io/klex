import { Box, type DOMElement, Text, useBoxMetrics, useInput } from 'ink';
import { useEffect, useRef, useState } from 'react';

import {
  deleteComposerText,
  insertComposerText,
  moveComposerCursor,
} from '../utils/message-composer';

/** Bounded, cursor-following input using the same editing rules as god messages. */
export function MultilineInput({
  value,
  onChange,
  onSubmit,
  height = 4,
  placeholder = 'Type instructions...',
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  height?: number;
  placeholder?: string;
}) {
  const [cursor, setCursor] = useState(value.length);
  const draft = useRef({ value, cursorOffset: value.length });
  useEffect(() => {
    // Parent-driven replacements must also replace the buffer used by input
    // handlers. Ordinary keystrokes already updated it synchronously.
    if (draft.current.value === value) return;
    draft.current = { value, cursorOffset: value.length };
    setCursor(value.length);
  }, [value]);
  const cursorRef = useRef<DOMElement>(null);
  const { height: cursorBottom } = useBoxMetrics(cursorRef);
  useInput((input, key) => {
    if (key.escape) return;
    if (key.return && !key.shift) {
      onSubmit(draft.current.value);
      return;
    }
    let next = draft.current;
    if (key.return) next = insertComposerText(next, '\n');
    else if (key.leftArrow || key.rightArrow)
      next = moveComposerCursor(next, key.leftArrow ? 'left' : 'right');
    else if (key.home) next = { ...next, cursorOffset: 0 };
    else if (key.end) next = { ...next, cursorOffset: next.value.length };
    else if (key.backspace || key.delete)
      next = deleteComposerText(next, key.backspace ? 'backward' : 'forward');
    else if (input && !key.ctrl && !key.meta && !key.tab)
      next = insertComposerText(next, input);
    else return;
    draft.current = next;
    setCursor(next.cursorOffset);
    onChange(next.value);
  });
  const cursorCharacter = Array.from(value.slice(cursor))[0] ?? ' ';
  return (
    <Box flexDirection="column" width="100%" height={height} overflow="hidden">
      <Box position="absolute" top={-100000} width="100%">
        <Box ref={cursorRef} flexShrink={0} width="100%">
          <Text wrap="hard">
            {value.slice(0, cursor)}
            {cursorCharacter}
          </Text>
        </Box>
      </Box>
      <Box
        flexDirection="column"
        flexShrink={0}
        position="relative"
        top={-Math.max(0, cursorBottom - height)}
        width="100%"
      >
        {value ? (
          <Text wrap="hard">
            {value.slice(0, cursor)}
            <Text inverse>{cursorCharacter}</Text>
            {value.slice(
              cursor + (cursor < value.length ? cursorCharacter.length : 0),
            )}
          </Text>
        ) : (
          <Text dimColor>{placeholder}</Text>
        )}
      </Box>
    </Box>
  );
}
