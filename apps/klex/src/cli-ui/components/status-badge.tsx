import { Text } from 'ink';

export function StatusBadge({
  status,
  label,
}: {
  status: 'ok' | 'warn' | 'error' | 'idle';
  label: string;
}) {
  const color =
    status === 'ok'
      ? 'green'
      : status === 'warn'
        ? 'yellow'
        : status === 'error'
          ? 'red'
          : 'gray';

  return (
    <Text color={color} bold>
      {label}
    </Text>
  );
}
