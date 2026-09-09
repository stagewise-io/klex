import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { useEffect } from 'react';

import type {
  AdminApiClient,
  CloudStatus,
  McpServersResponse,
  SessionInfo,
} from '../api-client';
import { DetailList, DetailRow } from '../components/detail-list';
import { EmptyState } from '../components/empty-state';
import { ScreenSection } from '../components/screen-section';
import {
  McpStatusBadge,
  StatusBadge,
  TunnelStatusBadge,
} from '../components/status-badge';
import { usePolling } from '../hooks/use-polling';
import { useScreenMeta } from '../hooks/use-screen-meta';
import { useToast } from '../hooks/use-toast';
import { MenuKeys, useMenuInput } from '../menu-keys';
import { formatAge } from '../utils/format-age';

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
        { key: 'g', label: 'Usage' },
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
      {sessions === null && !loading && <EmptyState>No data yet.</EmptyState>}
      {sessions !== null && sessions.length === 0 && (
        <EmptyState>No active sessions.</EmptyState>
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
      {!loading && status === null && <EmptyState>No data.</EmptyState>}
      {!loading && status !== null && !status.cloudEnabled && (
        <Text dimColor>Cloud Connection is disabled</Text>
      )}
      {!loading && status !== null && status.cloudEnabled && (
        <DetailList labelWidth={16}>
          <DetailRow label="Enrollment">
            <StatusBadge
              status={status.enrolled ? 'ok' : 'warn'}
              label={status.enrolled ? 'enrolled' : 'not enrolled'}
            />
          </DetailRow>
          <DetailRow label="Tunnel Status">
            <TunnelStatusBadge status={status.tunnelState} />
          </DetailRow>
        </DetailList>
      )}
    </ScreenSection>
  );
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
      {servers === null && !loading && <EmptyState>No data yet.</EmptyState>}
      {servers !== null && servers.length === 0 && (
        <EmptyState>No MCP servers configured.</EmptyState>
      )}
      {servers !== null && servers.length > 0 && (
        <Box flexDirection="column">
          {servers.map((server) => (
            <Box key={server.name}>
              <Text dimColor>{server.name} </Text>
              <McpStatusBadge status={server.status} />
              <Text dimColor>
                {' '}
                {server.toolCount} tools
                {server.supportsPushNotifications ? ' | push' : ''}
              </Text>
            </Box>
          ))}
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
