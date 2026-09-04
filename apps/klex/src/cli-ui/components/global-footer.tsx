import { Box, Text } from 'ink';

import type { CloudStatus, SessionInfo } from '../api-client';
import { StatusBadge } from './status-badge';

export interface GlobalFooterProps {
  keys: { key: string; label: string }[];
  sessions: SessionInfo[];
  cloud: CloudStatus | null;
  loading: boolean;
  toastCount: number;
  width?: number;
}

function formatShortcutKey(key: string): string {
  switch (key) {
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

export function GlobalFooter({
  keys,
  sessions,
  cloud,
  loading,
  toastCount,
  width,
}: GlobalFooterProps) {
  const activeSessions = sessions.filter(
    (session) =>
      session.runtimeState === 'running' || session.status === 'running',
  ).length;
  const availableWidth = width ?? 80;

  return (
    <Box flexDirection="column" flexShrink={0} width={width} paddingX={1}>
      <Text dimColor>{'─'.repeat(Math.max(availableWidth - 2, 1))}</Text>
      <Box justifyContent="space-between" flexWrap="wrap">
        <Box gap={2} flexWrap="wrap">
          {keys.map((shortcut) => (
            <Text key={shortcut.key}>
              <Text bold color="blue">
                [{formatShortcutKey(shortcut.key)}]
              </Text>{' '}
              <Text dimColor>{shortcut.label}</Text>
            </Text>
          ))}
        </Box>
        <Box gap={2} flexWrap="wrap">
          {loading ? (
            <Text dimColor>Starting…</Text>
          ) : (
            <>
              <Text dimColor>
                {sessions.length} session{sessions.length === 1 ? '' : 's'}
                {activeSessions > 0 ? ` · ${activeSessions} active` : ''}
              </Text>
              {cloud ? (
                <StatusBadge
                  status={
                    cloud.enrolled ? 'ok' : cloud.cloudEnabled ? 'warn' : 'idle'
                  }
                  label={
                    cloud.enrolled ? 'Cloud connected' : 'Cloud disconnected'
                  }
                />
              ) : null}
            </>
          )}
          {toastCount > 0 ? (
            <Text color="yellow">
              {toastCount} notice{toastCount === 1 ? '' : 's'}
            </Text>
          ) : null}
        </Box>
      </Box>
    </Box>
  );
}
