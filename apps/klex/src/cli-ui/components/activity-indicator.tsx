import { Text } from 'ink';
import Spinner from 'ink-spinner';

export function ActivityIndicator({ label }: { label: string }) {
  return (
    <Text dimColor>
      <Spinner type="dots" /> {label}
    </Text>
  );
}
