import { Box, Text } from 'ink';

import type { CloudStatus, SessionInfo, TunnelState } from '../api-client';
import { StatusBadge } from './status-badge';

export interface GlobalHeaderProps {
  screenTitle: string;
  breadcrumb: string[];
  sessions: SessionInfo[];
  cloud: CloudStatus | null;
  loading: boolean;
}

const tunnelBadge: Record<
  TunnelState,
  { status: 'ok' | 'warn' | 'error' | 'idle'; label: string }
> = {
  connected: { status: 'ok', label: 'tunnel up' },
  connecting: { status: 'warn', label: 'tunnel...' },
  error: { status: 'error', label: 'tunnel err' },
  disconnected: { status: 'idle', label: 'tunnel off' },
};

export function GlobalHeader({
  screenTitle,
  breadcrumb,
  sessions,
  cloud,
  loading,
}: GlobalHeaderProps) {
  const activeSessions = sessions.filter(
    (s) => s.runtimeState === 'running' || s.status === 'running',
  ).length;

  return (
    <Box flexDirection="column" flexShrink={0}>
      {/* Top bar: brand + live stats */}
      <Box justifyContent="space-between">
        <Box>
          <Text bold color="cyan">
            klex
          </Text>
          <Text dimColor> v1.0.0</Text>
        </Box>
        <Box gap={2}>
          {loading ? (
            <Text dimColor>connecting...</Text>
          ) : (
            <>
              <Box>
                <Text dimColor>sessions </Text>
                <Text bold>{sessions.length}</Text>
                {activeSessions > 0 && (
                  <Text dimColor> ({activeSessions} active)</Text>
                )}
              </Box>
              {cloud ? (
                <Box gap={2}>
                  <Box>
                    <Text dimColor>cloud </Text>
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
                            ? 'not enrolled'
                            : 'disabled'
                      }
                    />
                  </Box>
                  {cloud.cloudEnabled && cloud.enrolled && (
                    <Box>
                      <StatusBadge
                        status={tunnelBadge[cloud.tunnelState].status}
                        label={tunnelBadge[cloud.tunnelState].label}
                      />
                    </Box>
                  )}
                </Box>
              ) : (
                <Box>
                  <Text dimColor>cloud </Text>
                  <StatusBadge status="error" label="offline" />
                </Box>
              )}
            </>
          )}
        </Box>
      </Box>

      {/* Divider */}
      <Text dimColor>{'─'.repeat(60)}</Text>

      {/* Breadcrumb + screen title */}
      <Box>
        {breadcrumb.length > 0 && (
          <Text dimColor>
            {breadcrumb.join(' › ')}
            <Text> › </Text>
          </Text>
        )}
        <Text bold>{screenTitle}</Text>
      </Box>
    </Box>
  );
}
