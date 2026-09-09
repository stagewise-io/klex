import { Text, type TextProps } from 'ink';

export interface KeyHintProps {
  keyName: string;
  color?: TextProps['color'];
}

function formatKey(key: string): string {
  switch (key.toLowerCase()) {
    case 'escape':
    case 'esc':
      return 'Esc';
    case 'return':
    case 'enter':
      return 'Enter';
    case 'backspace':
      return 'Backspace';
    case 'delete':
      return 'Delete';
    default:
      return key;
  }
}

export function KeyHint({ keyName, color = 'blue' }: KeyHintProps) {
  return (
    <Text bold color={color}>
      [{formatKey(keyName)}]
    </Text>
  );
}
