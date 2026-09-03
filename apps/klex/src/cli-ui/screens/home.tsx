import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { useEffect } from 'react';

import type {
  AdminApiClient,
  CloudStatus,
  McpServersResponse,
  SessionInfo,
} from '../api-client';
import { StatusBadge } from '../components/status-badge';
import { usePolling } from '../hooks/use-polling';
import { useScreenMeta } from '../hooks/use-screen-meta';
import { useToast } from '../hooks/use-toast';
import { MenuKeys, useMenuInput } from '../menu-keys';

export interface HomeScreenProps {
  apiClient: AdminApiClient;
  sessions: SessionInfo[];
  cloud: CloudStatus | null;
  onRefreshGlobal: () => void;
  onOpenSettings: () => void;
  onOpenCloud: () => void;
  onOpenUsage: () => void;
}

export function HomeScreen({
  apiClient,
  sessions,
  cloud,
  onRefreshGlobal,
  onOpenSettings,
  onOpenCloud,
  onOpenUsage,
}: HomeScreenProps) {
  const { pushToast } = useToast();
  const { setMeta } = useScreenMeta();

  // Only MCP servers poll independently — sessions and cloud come from
  // the shared global status hook to avoid duplicate fetches.
  const mcpPoll = usePolling<McpServersResponse>(
    () => apiClient.getMcpServers(),
    5000,
  );

  useEffect(() => {
    if (mcpPoll.error) {
      pushToast(
        `Failed to load MCP servers: ${mcpPoll.error.message}`,
        'error',
      );
    }
  }, [mcpPoll.error, pushToast]);

  useEffect(() => {
    setMeta({
      title: 'Home',
      breadcrumb: [],
      keys: [
        { key: 's', label: 'Settings' },
        { key: 'c', label: 'Cloud' },
        { key: 'u', label: 'Usage' },
        { key: 'r', label: 'Refresh' },
      ],
    });
  }, [setMeta]);

  useMenuInput({
    [MenuKeys.Settings]: onOpenSettings,
    [MenuKeys.Cloud]: onOpenCloud,
    [MenuKeys.Usage]: onOpenUsage,
    [MenuKeys.Refresh]: () => {
      onRefreshGlobal();
      mcpPoll.refresh();
    },
  });

  return (
    <Box flexDirection="column">
      <SessionsSection loading={false} sessions={sessions} />
      <CloudSection loading={false} status={cloud} />
      <McpSection
        loading={mcpPoll.loading}
        servers={mcpPoll.data?.servers ?? null}
      />
    </Box>
  );
}

function SessionsSection({
  loading,
  sessions,
}: {
  loading: boolean;
  sessions: SessionInfo[] | null;
}) {
  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>Active Sessions</Text>
        {loading && (
          <Text>
            {' '}
            <Spinner type="dots" />
          </Text>
        )}
      </Box>
      {sessions === null && !loading && <Text dimColor>No data yet.</Text>}
      {sessions !== null && sessions.length === 0 && (
        <Text dimColor>No active sessions.</Text>
      )}
      {sessions !== null && sessions.length > 0 && (
        <Box flexDirection="column" marginLeft={2}>
          {sessions.map((session) => (
            <SessionRow key={session.id} session={session} />
          ))}
        </Box>
      )}
    </Box>
  );
}

function SessionRow({ session }: { session: SessionInfo }) {
  const age = formatAge(session.createdAt);
  const state = session.runtimeState || session.status || 'unknown';

  return (
    <Box flexDirection="column">
      <Box>
        <Text dimColor>id:</Text>
        <Text> {session.id}</Text>
        <Text> </Text>
        <StatusBadge
          status={
            state === 'running' ? 'ok' : state === 'idle' ? 'idle' : 'warn'
          }
          label={`[${state}]`}
        />
      </Box>
      <Box marginLeft={2} flexDirection="column">
        <Text dimColor>
          age: {age} | turns: {session.turns} | steps: {session.steps} | msgs:{' '}
          {session.messageCount}
        </Text>
        {session.model && (
          <Text dimColor>
            model: {session.model.id}
            {session.model.isFallback
              ? ` (fallback #${session.model.fallbackIndex})`
              : ''}
          </Text>
        )}
      </Box>
    </Box>
  );
}

function CloudSection({
  loading,
  status,
}: {
  loading: boolean;
  status: CloudStatus | null;
}) {
  return (
    <Box marginTop={1} flexDirection="column">
      <Text bold>Cloud</Text>
      {loading && (
        <Text>
          {' '}
          <Spinner type="dots" />
        </Text>
      )}
      {!loading && status === null && <Text dimColor>No data.</Text>}
      {!loading && status !== null && (
        <Box marginLeft={2} flexDirection="column">
          <Box>
            <Text dimColor>enabled: </Text>
            <StatusBadge
              status={status.cloudEnabled ? 'ok' : 'idle'}
              label={status.cloudEnabled ? 'yes' : 'no'}
            />
          </Box>
          <Box>
            <Text dimColor>enrolled: </Text>
            <StatusBadge
              status={status.enrolled ? 'ok' : 'warn'}
              label={status.enrolled ? 'yes' : 'no'}
            />
          </Box>
          {status.enrolled && status.clientId && (
            <Text dimColor>enrollment ID: {status.clientId}</Text>
          )}
          {status.enrolled && status.cloudEnabled && (
            <Box>
              <Text dimColor>tunnel: </Text>
              <StatusBadge
                status={
                  status.tunnelState === 'connected'
                    ? 'ok'
                    : status.tunnelState === 'connecting'
                      ? 'warn'
                      : status.tunnelState === 'error'
                        ? 'error'
                        : 'idle'
                }
                label={
                  status.tunnelState === 'connected'
                    ? 'connected'
                    : status.tunnelState === 'connecting'
                      ? 'connecting'
                      : status.tunnelState === 'error'
                        ? 'error — reconnecting'
                        : 'disconnected'
                }
              />
            </Box>
          )}
          {!status.enrolled && status.cloudEnabled && (
            <Text color="yellow">Press c to enroll</Text>
          )}
          {!status.cloudEnabled && (
            <Text dimColor>cloud disabled — use --no-cloud to toggle</Text>
          )}
          {status.cloudEnabled && (
            <Text dimColor>cloud URL: {status.cloudBaseUrl}</Text>
          )}
        </Box>
      )}
    </Box>
  );
}

function mcpStatusToBadge(status: string): {
  status: 'ok' | 'warn' | 'error' | 'idle';
  label: string;
} {
  switch (status) {
    case 'connected':
      return { status: 'ok', label: 'connected' };
    case 'connecting':
      return { status: 'warn', label: 'connecting' };
    case 'authorization_required':
      return { status: 'warn', label: 'auth required' };
    case 'authorizing':
      return { status: 'warn', label: 'authorizing' };
    case 'error':
      return { status: 'error', label: 'error' };
    default:
      return { status: 'idle', label: 'disconnected' };
  }
}

function McpSection({
  loading,
  servers,
}: {
  loading: boolean;
  servers: McpServersResponse['servers'] | null;
}) {
  return (
    <Box marginTop={1} flexDirection="column">
      <Box>
        <Text bold>MCP Servers</Text>
        {loading && (
          <Text>
            {' '}
            <Spinner type="dots" />
          </Text>
        )}
      </Box>
      {servers === null && !loading && <Text dimColor>No data yet.</Text>}
      {servers !== null && servers.length === 0 && (
        <Text dimColor>No MCP servers configured.</Text>
      )}
      {servers !== null && servers.length > 0 && (
        <Box marginLeft={2} flexDirection="column">
          {servers.map((server) => {
            const badge = mcpStatusToBadge(server.status);
            return (
              <Box key={server.name}>
                <Text dimColor>{server.name} </Text>
                <StatusBadge status={badge.status} label={badge.label} />
                <Text dimColor>
                  {' '}
                  {server.toolCount} tools
                  {server.supportsPushNotifications ? ' | push' : ''}
                </Text>
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
}

function formatAge(isoDate: string): string {
  const created = new Date(isoDate).getTime();
  if (Number.isNaN(created)) return 'unknown';
  const elapsed = Date.now() - created;
  if (elapsed < 60_000) return `${Math.floor(elapsed / 1000)}s`;
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  return `${Math.floor(elapsed / 86_400_000)}d`;
}
