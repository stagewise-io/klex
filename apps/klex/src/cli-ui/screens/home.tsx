import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { useEffect } from 'react';

import type {
  AdminApiClient,
  CloudStatus,
  McpServersResponse,
  SessionInfo,
} from '../api-client';
import { ScreenSection } from '../components/screen-section';
import { StatusBadge } from '../components/status-badge';
import { usePolling } from '../hooks/use-polling';
import { useScreenMeta } from '../hooks/use-screen-meta';
import { useToast } from '../hooks/use-toast';
import { MenuKeys, useMenuInput } from '../menu-keys';

export interface HomeScreenProps {
  apiClient: AdminApiClient;
  sessions: SessionInfo[];
  cloud: CloudStatus | null;
  dangerousLocalAdminApiPort: number | undefined;
  onRefreshGlobal: () => void;
  onOpenSettings: () => void;
  onOpenUsage: () => void;
}

export function HomeScreen({
  apiClient,
  sessions,
  cloud,
  dangerousLocalAdminApiPort,
  onRefreshGlobal,
  onOpenSettings,
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
        { key: 'u', label: 'Usage' },
        { key: 'r', label: 'Refresh' },
      ],
    });
  }, [setMeta]);

  useMenuInput({
    [MenuKeys.Settings]: onOpenSettings,
    [MenuKeys.Usage]: onOpenUsage,
    [MenuKeys.Refresh]: () => {
      onRefreshGlobal();
      mcpPoll.refresh();
    },
  });

  const unsafeCloudConnection =
    cloud?.cloudEnabled === true && isUnsafeCloudUrl(cloud.cloudBaseUrl);

  return (
    <Box flexDirection="column" gap={1}>
      {unsafeCloudConnection ? (
        <ScreenSection title="Unsafe cloud connection" tone="yellow">
          <Text>
            Cloud traffic uses an unencrypted connection ({cloud.cloudBaseUrl}).
          </Text>
          <Text dimColor>
            Credentials and agent data may be visible in transit. Use HTTPS in
            production.
          </Text>
        </ScreenSection>
      ) : null}
      {dangerousLocalAdminApiPort !== undefined ? (
        <ScreenSection title="Security warning" tone="yellow">
          <Text>
            The unauthenticated Admin API is exposed at
            {` http://127.0.0.1:${dangerousLocalAdminApiPort}`}.
          </Text>
        </ScreenSection>
      ) : null}
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
    <ScreenSection title="Active Sessions">
      <Box>
        {loading && (
          <Text>
            <Spinner type="dots" />
          </Text>
        )}
      </Box>
      {sessions === null && !loading && <Text dimColor>No data yet.</Text>}
      {sessions !== null && sessions.length === 0 && (
        <Text dimColor>No active sessions.</Text>
      )}
      {sessions !== null && sessions.length > 0 && (
        <Box flexDirection="column">
          {sessions.map((session) => (
            <SessionRow key={session.id} session={session} />
          ))}
        </Box>
      )}
    </ScreenSection>
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
            model: {session.model.id ?? 'not configured'}
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
    <ScreenSection title="Cloud">
      {loading && (
        <Text>
          <Spinner type="dots" />
        </Text>
      )}
      {!loading && status === null && <Text dimColor>No data.</Text>}
      {!loading && status !== null && !status.cloudEnabled && (
        <Text dimColor>Cloud Connection is disabled</Text>
      )}
      {!loading && status !== null && status.cloudEnabled && (
        <Box flexDirection="column">
          <Box>
            <Text dimColor>Enrollment: </Text>
            <StatusBadge
              status={status.enrolled ? 'ok' : 'warn'}
              label={status.enrolled ? 'enrolled' : 'not enrolled'}
            />
          </Box>
          <Box>
            <Text dimColor>Tunnel Status: </Text>
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
        </Box>
      )}
    </ScreenSection>
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
    <ScreenSection title="MCP Servers">
      <Box>
        {loading && (
          <Text>
            <Spinner type="dots" />
          </Text>
        )}
      </Box>
      {servers === null && !loading && <Text dimColor>No data yet.</Text>}
      {servers !== null && servers.length === 0 && (
        <Text dimColor>No MCP servers configured.</Text>
      )}
      {servers !== null && servers.length > 0 && (
        <Box flexDirection="column">
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
    </ScreenSection>
  );
}

function isUnsafeCloudUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'ws:';
  } catch {
    return /^(?:http|ws):\/\//i.test(value);
  }
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
