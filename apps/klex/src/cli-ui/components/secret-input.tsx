import { Box, Text, useInput } from 'ink';
import { useCallback, useState } from 'react';

export interface SecretInputProps {
  label: string;
  placeholder?: string;
  onSubmit: (value: string) => void;
}

/**
 * Input that masks entered text. The raw value is kept in internal state
 * and only passed to the parent on submit — never rendered in cleartext.
 *
 * Uses `useInput` directly instead of `ink-text-input` because TextInput's
 * `value` prop doubles as the displayed text — setting it to bullets
 * corrupts the internal value on every keystroke.
 */
export function SecretInput({
  label,
  placeholder,
  onSubmit,
}: SecretInputProps) {
  const [value, setValue] = useState('');

  useInput(
    useCallback(
      (input, key) => {
        if (key.return) {
          if (value.length > 0) {
            onSubmit(value);
            setValue('');
          }
          return;
        }
        if (key.backspace || key.delete) {
          setValue((v) => v.slice(0, -1));
          return;
        }
        // Only accept printable characters, ignore ctrl/meta combos
        if (input && !key.ctrl && !key.meta && !key.escape) {
          setValue((v) => v + input);
        }
      },
      [value, onSubmit],
    ),
  );

  const maskedDisplay =
    value.length > 0 ? '•'.repeat(Math.min(value.length, 40)) : '';

  return (
    <Box>
      <Text>{label}: </Text>
      {value.length === 0 ? (
        <Text dimColor>{placeholder ?? 'Enter secret...'}</Text>
      ) : (
        <Text>
          {maskedDisplay}
          <Text dimColor>█</Text>
        </Text>
      )}
    </Box>
  );
}
