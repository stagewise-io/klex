import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import { useEffect, useState } from 'react';

import {
  type AdminApiClient,
  AdminApiClientError,
  type McpServersResponse,
} from '../api-client';
import { StatusBadge } from '../components/status-badge';
import { usePolling } from '../hooks/use-polling';
import { useScreenMeta } from '../hooks/use-screen-meta';
import { useTextInputActive } from '../hooks/use-text-input-active';
import { useToast } from '../hooks/use-toast';
import { MenuKeys, useMenuInput } from '../menu-keys';

export interface McpScreenProps {
  apiClient: AdminApiClient;
  onBack: () => void;
}

interface MenuItem {
  label: string;
  value: string;
}

type Mode =
  | 'list'
  | 'add-name'
  | 'add-url'
  | 'delete-confirm'
  | 'detail'
  | 'edit-url'
  | 'edit-command';

export function McpScreen({ apiClient, onBack }: McpScreenProps) {
  const { pushToast } = useToast();
  const { setMeta } = useScreenMeta();
  const { setActive } = useTextInputActive();
  const [mode, setMode] = useState<Mode>('list');
  const [selectedServer, setSelectedServer] = useState<string | null>(null);
  const [pendingName, setPendingName] = useState('');
  const [pendingUrl, setPendingUrl] = useState('');
  const [pendingCommand, setPendingCommand] = useState('');

  const serversPoll = usePolling<McpServersResponse>(
    () => apiClient.getMcpServers(),
    5000,
  );

  useEffect(() => {
    if (serversPoll.error) {
      pushToast(
        `Failed to load MCP servers: ${serversPoll.error.message}`,
        'error',
      );
    }
  }, [serversPoll.error, pushToast]);

  const selectedInfo = serversPoll.data?.servers.find(
    (s) => s.name === selectedServer,
  );

  useEffect(() => {
    setActive(
      mode === 'add-name' ||
        mode === 'add-url' ||
        mode === 'edit-url' ||
        mode === 'edit-command',
    );
  }, [mode, setActive]);

  useEffect(() => {
    const titles: Record<Mode, string> = {
      list: 'MCP Servers',
      'add-name': 'Add MCP Server — Name',
      'add-url': `Add MCP Server — URL (${pendingName})`,
      'delete-confirm': `Delete "${selectedServer}"`,
      detail: `MCP Server: ${selectedServer}`,
      'edit-url': `Edit URL: ${selectedServer}`,
      'edit-command': `Edit Command: ${selectedServer}`,
    };
    const keysByMode: Record<Mode, { key: string; label: string }[]> = {
      list: [
        { key: 'a', label: 'Add' },
        { key: 'enter', label: 'View' },
        { key: 'esc', label: 'Back' },
      ],
      'add-name': [
        { key: 'enter', label: 'Next' },
        { key: 'esc', label: 'Cancel' },
      ],
      'add-url': [
        { key: 'enter', label: 'Add' },
        { key: 'esc', label: 'Cancel' },
      ],
      'delete-confirm': [
        { key: 'y', label: 'Confirm' },
        { key: 'n', label: 'Cancel' },
      ],
      detail: [
        { key: 'e', label: 'Edit' },
        { key: 'd', label: 'Delete' },
        { key: 'esc', label: 'Back' },
      ],
      'edit-url': [
        { key: 'enter', label: 'Save' },
        { key: 'esc', label: 'Cancel' },
      ],
      'edit-command': [
        { key: 'enter', label: 'Save' },
        { key: 'esc', label: 'Cancel' },
      ],
    };
    setMeta({
      title: titles[mode],
      breadcrumb: ['Home', 'Settings'],
      keys: keysByMode[mode],
    });
  }, [setMeta, mode, pendingName, selectedServer]);

  useMenuInput({
    [MenuKeys.Back]: () => {
      if (mode === 'list') onBack();
      else if (mode === 'add-name' || mode === 'add-url') setMode('list');
      else if (mode === 'detail') {
        setMode('list');
        setSelectedServer(null);
      } else if (
        mode === 'edit-url' ||
        mode === 'edit-command' ||
        mode === 'delete-confirm'
      ) {
        setMode('detail');
      } else setMode('list');
    },
    [MenuKeys.Add]: () => {
      if (mode === 'list') setMode('add-name');
    },
    [MenuKeys.Edit]: () => {
      if (mode === 'detail' && selectedInfo) {
        if (selectedInfo.transport === 'http') {
          setPendingUrl('');
          setMode('edit-url');
        } else {
          setPendingCommand('');
          setMode('edit-command');
        }
      }
    },
    [MenuKeys.Delete]: () => {
      if (mode === 'detail' && selectedServer) {
        setMode('delete-confirm');
      }
    },
  });

  // --- Add flow ---

  if (mode === 'add-name') {
    return (
      <Box flexDirection="column">
        <Box marginTop={1}>
          <Text>
            Name:{' '}
            <TextInput
              value={pendingName}
              onChange={setPendingName}
              placeholder="server-name"
              onSubmit={() => {
                if (pendingName.trim()) setMode('add-url');
              }}
              showCursor
            />
          </Text>
        </Box>
      </Box>
    );
  }

  if (mode === 'add-url') {
    return (
      <Box flexDirection="column">
        <Box marginTop={1}>
          <Text>
            URL:{' '}
            <TextInput
              value={pendingUrl}
              onChange={setPendingUrl}
              placeholder="http://localhost:3000/sse"
              onSubmit={async () => {
                if (!pendingUrl.trim()) return;
                try {
                  await apiClient.createMcpServer({
                    name: pendingName,
                    transport: 'sse',
                    url: pendingUrl,
                  });
                  pushToast('MCP server added', 'info');
                  setPendingName('');
                  setPendingUrl('');
                  setMode('list');
                  serversPoll.refresh();
                } catch (err) {
                  pushToast(
                    err instanceof AdminApiClientError
                      ? err.message
                      : 'Add failed',
                    'error',
                  );
                  setMode('list');
                }
              }}
              showCursor
            />
          </Text>
        </Box>
      </Box>
    );
  }

  // --- Edit URL flow ---

  if (mode === 'edit-url' && selectedServer) {
    return (
      <Box flexDirection="column">
        <Box marginTop={1}>
          <Text>
            New URL:{' '}
            <TextInput
              value={pendingUrl}
              onChange={setPendingUrl}
              placeholder="http://localhost:3000/sse"
              onSubmit={async () => {
                if (!pendingUrl.trim()) return;
                try {
                  await apiClient.updateMcpServer(selectedServer, {
                    type: 'streamable-http',
                    url: pendingUrl,
                  });
                  pushToast('MCP server updated', 'info');
                  setPendingUrl('');
                  setMode('detail');
                  serversPoll.refresh();
                } catch (err) {
                  pushToast(
                    err instanceof AdminApiClientError
                      ? err.message
                      : 'Update failed',
                    'error',
                  );
                  setMode('detail');
                }
              }}
              showCursor
            />
          </Text>
        </Box>
      </Box>
    );
  }

  // --- Edit command flow ---

  if (mode === 'edit-command' && selectedServer) {
    return (
      <Box flexDirection="column">
        <Box marginTop={1}>
          <Text>
            New command:{' '}
            <TextInput
              value={pendingCommand}
              onChange={setPendingCommand}
              placeholder="npx -y @some/mcp-server"
              onSubmit={async () => {
                if (!pendingCommand.trim()) return;
                try {
                  await apiClient.updateMcpServer(selectedServer, {
                    command: pendingCommand,
                  });
                  pushToast('MCP server updated', 'info');
                  setPendingCommand('');
                  setMode('detail');
                  serversPoll.refresh();
                } catch (err) {
                  pushToast(
                    err instanceof AdminApiClientError
                      ? err.message
                      : 'Update failed',
                    'error',
                  );
                  setMode('detail');
                }
              }}
              showCursor
            />
          </Text>
        </Box>
      </Box>
    );
  }

  // --- Delete confirm ---

  if (mode === 'delete-confirm' && selectedServer) {
    return (
      <Box flexDirection="column">
        <Box marginTop={1}>
          <Text color="red">
            Are you sure? Press [y] to confirm, [esc] to cancel.
          </Text>
        </Box>
        <ConfirmInput
          onConfirm={async () => {
            try {
              await apiClient.deleteMcpServer(selectedServer);
              pushToast('MCP server deleted', 'info');
              setSelectedServer(null);
              setMode('list');
              serversPoll.refresh();
            } catch (err) {
              pushToast(
                err instanceof AdminApiClientError
                  ? err.message
                  : 'Delete failed',
                'error',
              );
              setMode('detail');
            }
          }}
          onCancel={() => setMode('detail')}
        />
      </Box>
    );
  }

  // --- Detail mode ---

  if (mode === 'detail' && selectedServer && selectedInfo) {
    const badge = mcpStatusToBadge(selectedInfo.status);
    return (
      <Box flexDirection="column">
        <Box marginTop={1} flexDirection="column">
          <Box>
            <Text dimColor>name: </Text>
            <Text bold>{selectedInfo.name}</Text>
          </Box>
          <Box>
            <Text dimColor>status: </Text>
            <StatusBadge status={badge.status} label={badge.label} />
          </Box>
          <Box>
            <Text dimColor>transport: </Text>
            <Text>{selectedInfo.transport}</Text>
          </Box>
          <Box>
            <Text dimColor>tools: </Text>
            <Text>{selectedInfo.toolCount}</Text>
          </Box>
          <Box>
            <Text dimColor>push notifications: </Text>
            <Text>{selectedInfo.supportsPushNotifications ? 'yes' : 'no'}</Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>
              Press [e] to edit, [d] to delete, [esc] to go back
            </Text>
          </Box>
        </Box>
      </Box>
    );
  }

  // --- List mode ---

  const servers = serversPoll.data?.servers ?? [];
  const items: MenuItem[] = servers.map((s) => ({
    label: `${s.name} [${s.status}] — ${s.toolCount} tools${s.supportsPushNotifications ? ' | push' : ''}`,
    value: s.name,
  }));

  return (
    <Box flexDirection="column">
      <Box marginTop={1} flexDirection="column">
        {serversPoll.loading && <Text dimColor>Loading...</Text>}
        {!serversPoll.loading && servers.length === 0 && (
          <Text dimColor>No MCP servers configured.</Text>
        )}
        {servers.length > 0 && (
          <SelectInput
            items={items}
            onSelect={(item) => {
              setSelectedServer(item.value);
              setMode('detail');
            }}
          />
        )}
      </Box>
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

function ConfirmInput({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useMenuInput({
    y: onConfirm,
    n: onCancel,
  });
  return null;
}
