import { Box, Text } from 'ink';

import type { CloudStatus, SessionInfo } from '../api-client';
import { StatusBadge } from './status-badge';

export interface GlobalFooterProps {
  keys: { key: string; label: string }[];
  sessions: SessionInfo[];
  cloud: CloudStatus | null;
  loading: boolean;
  toastCount: number;
}

export function GlobalFooter({
  keys,
  sessions,
  cloud,
  loading,
  toastCount,
}: GlobalFooterProps) {
  const activeSessions = sessions.filter(
    (s) => s.runtimeState === 'running' || s.status === 'running',
  ).length;

  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text dimColor>{'─'.repeat(60)}</Text>

      {/* Key hints */}
      <Box gap={1}>
        {keys.map((k) => (
          <Text key={k.key} dimColor>
            [{k.key}] {k.label}
          </Text>
        ))}
      </Box>

      {/* Status bar: session summary + cloud + toast indicator */}
      <Box justifyContent="space-between">
        <Box gap={2}>
          {loading ? (
            <Text dimColor>initializing...</Text>
          ) : (
            <>
              <Box>
                <Text dimColor>sessions: </Text>
                <Text bold>{sessions.length}</Text>
                {activeSessions > 0 && (
                  <StatusBadge
                    status="ok"
                    label={` ${activeSessions} active`}
                  />
                )}
              </Box>
              {cloud ? (
                <Box>
                  <Text dimColor>cloud: </Text>
                  <StatusBadge
                    status={
                      cloud.enrolled
                        ? 'ok'
                        : cloud.cloudEnabled
                          ? 'warn'
                          : 'idle'
                    }
                    label={
                      cloud.enrolled
                        ? 'enrolled'
                        : cloud.cloudEnabled
                          ? 'pending'
                          : 'off'
                    }
                  />
                </Box>
              ) : (
                <Box>
                  <Text dimColor>cloud: </Text>
                  <StatusBadge status="error" label="offline" />
                </Box>
              )}
            </>
          )}
        </Box>
        {toastCount > 0 && (
          <Text color="yellow">
            ⚠ {toastCount} notification{toastCount > 1 ? 's' : ''}
          </Text>
        )}
      </Box>
    </Box>
  );
}
