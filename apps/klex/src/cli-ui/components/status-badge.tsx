import { Text } from 'ink';

type StatusTone = 'ok' | 'warn' | 'error' | 'idle';

export function StatusBadge({
  status,
  label,
}: {
  status: StatusTone;
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

export function McpStatusBadge({ status }: { status: string }) {
  const presentation =
    status === 'connected'
      ? { status: 'ok' as const, label: 'connected' }
      : status === 'connecting'
        ? { status: 'warn' as const, label: 'connecting' }
        : status === 'authorization_required'
          ? { status: 'warn' as const, label: 'auth required' }
          : status === 'authorizing'
            ? { status: 'warn' as const, label: 'authorizing' }
            : status === 'error'
              ? { status: 'error' as const, label: 'error' }
              : { status: 'idle' as const, label: 'disconnected' };

  return <StatusBadge {...presentation} />;
}

export function TunnelStatusBadge({ status }: { status: string }) {
  const presentation =
    status === 'connected'
      ? { status: 'ok' as const, label: 'connected' }
      : status === 'connecting'
        ? { status: 'warn' as const, label: 'connecting' }
        : status === 'error'
          ? { status: 'error' as const, label: 'error — reconnecting' }
          : { status: 'idle' as const, label: 'disconnected' };

  return <StatusBadge {...presentation} />;
}
