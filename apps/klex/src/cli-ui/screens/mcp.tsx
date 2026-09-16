import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { useEffect, useState } from 'react';

import {
  type AdminApiClient,
  AdminApiClientError,
  type McpServersResponse,
} from '../api-client';
import { ActivityIndicator } from '../components/activity-indicator';
import { ConfirmationPanel } from '../components/confirmation-panel';
import { DetailList, DetailRow } from '../components/detail-list';
import { EmptyState } from '../components/empty-state';
import { KeyHint } from '../components/key-hint';
import { MenuList } from '../components/menu-list';
import { McpStatusBadge } from '../components/status-badge';
import { usePolling } from '../hooks/use-polling';
import { useScreenMeta } from '../hooks/use-screen-meta';
import { useTextInputActive } from '../hooks/use-text-input-active';
import { useToast } from '../hooks/use-toast';
import { MenuKeys, useMenuInput } from '../menu-keys';
import {
  buildHeaderUpdates,
  buildHttpMcpFormConfig,
  type HttpHeaderEntry,
  headersFromEntries,
  validateHttpMcpUrl,
} from './mcp-headers';

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
  | 'add-headers'
  | 'header-key'
  | 'header-value'
  | 'delete-confirm'
  | 'detail'
  | 'edit-http'
  | 'edit-url'
  | 'edit-headers'
  | 'edit-command';

export function McpScreen({ apiClient, onBack }: McpScreenProps) {
  const { pushToast } = useToast();
  const { setMeta } = useScreenMeta();
  const { setActive } = useTextInputActive();
  const [mode, setMode] = useState<Mode>('list');
  const [highlightedServer, setHighlightedServer] = useState<string>();
  const [selectedServer, setSelectedServer] = useState<string | null>(null);
  const [pendingName, setPendingName] = useState('');
  const [pendingUrl, setPendingUrl] = useState('');
  const [pendingHeaders, setPendingHeaders] = useState<HttpHeaderEntry[]>([]);
  const [headersReturnMode, setHeadersReturnMode] = useState<
    'add-headers' | 'edit-headers'
  >('add-headers');
  const [highlightedHeaderIndex, setHighlightedHeaderIndex] = useState(0);
  const [highlightedEditOption, setHighlightedEditOption] = useState(0);
  const [editingHeaderIndex, setEditingHeaderIndex] = useState<number>();
  const [pendingHeaderKey, setPendingHeaderKey] = useState('');
  const [pendingHeaderValue, setPendingHeaderValue] = useState('');
  const [pendingCommand, setPendingCommand] = useState('');
  const [formError, setFormError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

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

  const beginHeaderEntry = (index?: number) => {
    const entry = index === undefined ? undefined : pendingHeaders[index];
    setEditingHeaderIndex(index);
    setPendingHeaderKey(entry?.key ?? '');
    setPendingHeaderValue(entry?.value ?? '');
    setFormError(undefined);
    setMode('header-key');
  };

  const continueHeaderEntry = () => {
    const key = pendingHeaderKey.trim();
    if (!key) {
      setFormError('Header name is required');
      return;
    }

    const duplicateIndex = pendingHeaders.findIndex(
      (entry, index) =>
        index !== editingHeaderIndex &&
        entry.key.trim().toLowerCase() === key.toLowerCase(),
    );
    if (duplicateIndex !== -1) {
      setFormError(`Header "${key}" already exists`);
      return;
    }

    setPendingHeaderKey(key);
    setFormError(undefined);
    setMode('header-value');
  };

  const commitHeaderEntry = async () => {
    const entry = { key: pendingHeaderKey.trim(), value: pendingHeaderValue };
    if (headersReturnMode === 'edit-headers' && selectedServer) {
      setSubmitting(true);
      try {
        const previousKey =
          editingHeaderIndex === undefined
            ? undefined
            : pendingHeaders[editingHeaderIndex]?.key;
        const headerUpdates = buildHeaderUpdates(
          previousKey,
          entry.key,
          entry.value,
        );
        await apiClient.updateMcpServer(selectedServer, { headerUpdates });
        pushToast('MCP header updated', 'info');
        serversPoll.refresh();
      } catch (err) {
        setFormError(
          err instanceof AdminApiClientError ? err.message : 'Update failed',
        );
        setSubmitting(false);
        return;
      }
      setSubmitting(false);
    }

    setPendingHeaders((headers) => {
      if (editingHeaderIndex === undefined) return [...headers, entry];
      return headers.map((header, index) =>
        index === editingHeaderIndex ? entry : header,
      );
    });
    setEditingHeaderIndex(undefined);
    setPendingHeaderKey('');
    setPendingHeaderValue('');
    setFormError(undefined);
    setMode(headersReturnMode);
  };

  const deleteHeaderEntry = async (index: number) => {
    const entry = pendingHeaders[index];
    if (!entry) return;

    if (headersReturnMode === 'edit-headers' && selectedServer) {
      setSubmitting(true);
      try {
        await apiClient.updateMcpServer(selectedServer, {
          headerUpdates: { [entry.key]: null },
        });
        pushToast('MCP header removed', 'info');
        serversPoll.refresh();
      } catch (err) {
        setFormError(
          err instanceof AdminApiClientError ? err.message : 'Delete failed',
        );
        setSubmitting(false);
        return;
      }
      setSubmitting(false);
    }

    setPendingHeaders((headers) =>
      headers.filter((_, headerIndex) => headerIndex !== index),
    );
    setHighlightedHeaderIndex((highlightedIndex) =>
      Math.max(0, Math.min(highlightedIndex, pendingHeaders.length - 2)),
    );
  };

  const submitHttpServer = async () => {
    if (submitting) return;
    setSubmitting(true);
    setFormError(undefined);

    try {
      const config = buildHttpMcpFormConfig(
        pendingUrl,
        headersFromEntries(pendingHeaders),
      );
      await apiClient.createMcpServer({
        name: pendingName.trim(),
        ...config,
      });
      pushToast('MCP server added', 'info');
      setPendingName('');
      setMode('list');
      setPendingUrl('');
      setPendingHeaders([]);
      setHighlightedHeaderIndex(0);
      serversPoll.refresh();
    } catch (err) {
      setFormError(
        err instanceof AdminApiClientError ? err.message : 'Save failed',
      );
    } finally {
      setSubmitting(false);
    }
  };

  useEffect(() => {
    setActive(
      mode === 'add-name' ||
        mode === 'add-url' ||
        mode === 'header-key' ||
        mode === 'header-value' ||
        mode === 'edit-url' ||
        mode === 'edit-command',
    );
  }, [mode, setActive]);

  useEffect(() => {
    const titles: Record<Mode, string> = {
      list: 'MCP Servers',
      'add-name': 'Add MCP Server — Name',
      'add-url': `Add MCP Server — URL (${pendingName})`,
      'add-headers': `Add MCP Server — Headers (${pendingName})`,
      'header-key': 'Header Name',
      'header-value': `Header Value (${pendingHeaderKey.trim() || 'new header'})`,
      'delete-confirm': `Delete "${selectedServer}"`,
      detail: `MCP Server: ${selectedServer}`,
      'edit-http': `Edit MCP Server: ${selectedServer}`,
      'edit-url': `Edit URL: ${selectedServer}`,
      'edit-headers': `Edit Headers: ${selectedServer}`,
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
        { key: 'enter', label: 'Next' },
        { key: 'esc', label: 'Cancel' },
      ],
      'add-headers': [
        { key: 'a', label: 'Add header' },
        { key: 'enter', label: 'Edit' },
        { key: 'd', label: 'Delete' },
        { key: 's', label: 'Add server' },
        { key: 'esc', label: 'Back' },
      ],
      'header-key': [
        { key: 'enter', label: 'Next' },
        { key: 'esc', label: 'Back' },
      ],
      'header-value': [
        { key: 'enter', label: 'Set value' },
        { key: 'esc', label: 'Back' },
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
      'edit-http': [
        { key: 'enter', label: 'Edit' },
        { key: 'esc', label: 'Back' },
      ],
      'edit-url': [
        { key: 'enter', label: 'Save' },
        { key: 'esc', label: 'Cancel' },
      ],
      'edit-headers': [
        { key: 'a', label: 'Add header' },
        { key: 'enter', label: 'Edit' },
        { key: 'd', label: 'Delete' },
        { key: 'esc', label: 'Back' },
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
  }, [setMeta, mode, pendingHeaderKey, pendingName, selectedServer]);

  useMenuInput({
    [MenuKeys.Back]: () => {
      if (submitting) return;
      setFormError(undefined);
      if (mode === 'list') onBack();
      else if (mode === 'add-name' || mode === 'add-url') setMode('list');
      else if (mode === 'add-headers') setMode('add-url');
      else if (mode === 'header-key') setMode(headersReturnMode);
      else if (mode === 'header-value') setMode('header-key');
      else if (mode === 'detail') {
        setMode('list');
        setSelectedServer(null);
      } else if (
        mode === 'edit-http' ||
        mode === 'edit-url' ||
        mode === 'edit-command' ||
        mode === 'delete-confirm'
      ) {
        setMode('detail');
      } else if (mode === 'edit-headers') {
        setMode('edit-http');
      } else setMode('list');
    },
    [MenuKeys.Add]: () => {
      if (mode === 'list') {
        setFormError(undefined);
        setPendingHeaders([]);
        setHeadersReturnMode('add-headers');
        setMode('add-name');
      } else if (mode === 'add-headers' || mode === 'edit-headers') {
        beginHeaderEntry();
      }
    },
    [MenuKeys.Edit]: () => {
      if (mode === 'detail' && selectedInfo) {
        setFormError(undefined);
        if (selectedInfo.transport === 'http') {
          setPendingUrl('');
          setPendingHeaders(
            (selectedInfo.headerNames ?? []).map((key) => ({ key, value: '' })),
          );
          setHeadersReturnMode('edit-headers');
          setMode('edit-http');
        } else {
          setPendingCommand('');
          setMode('edit-command');
        }
      }
    },
    [MenuKeys.Delete]: () => {
      if (mode === 'detail' && selectedServer) {
        setMode('delete-confirm');
      } else if (
        (mode === 'add-headers' || mode === 'edit-headers') &&
        pendingHeaders.length > 0
      ) {
        void deleteHeaderEntry(highlightedHeaderIndex);
      }
    },
    s: () => {
      if (mode === 'add-headers') void submitHttpServer();
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
              onChange={(value) => {
                setPendingName(value);
                setFormError(undefined);
              }}
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
              onChange={(value) => {
                setPendingUrl(value);
                setFormError(undefined);
              }}
              placeholder="http://localhost:3000/mcp"
              onSubmit={() => {
                try {
                  validateHttpMcpUrl(pendingUrl);
                  setFormError(undefined);
                  setMode('add-headers');
                } catch (error) {
                  setFormError(
                    error instanceof Error ? error.message : 'Invalid URL',
                  );
                }
              }}
              showCursor
            />
          </Text>
        </Box>
        {formError ? <Text color="red">{formError}</Text> : null}
      </Box>
    );
  }

  if (mode === 'add-headers' || mode === 'edit-headers') {
    const headerItems = pendingHeaders.map((header, index) => ({
      label: `${header.key}: ••••••••`,
      value: String(index),
    }));
    return (
      <Box flexDirection="column">
        <Box marginTop={1} flexDirection="column">
          {headerItems.length === 0 ? (
            <EmptyState>No custom headers configured.</EmptyState>
          ) : (
            <MenuList
              items={headerItems}
              selectedIndex={highlightedHeaderIndex}
              visibleCount={8}
              onHighlight={(item) =>
                setHighlightedHeaderIndex(Number(item.value))
              }
              onSelect={(item) => beginHeaderEntry(Number(item.value))}
            />
          )}
          {mode === 'add-headers' ? (
            <Text dimColor>
              Press <KeyHint keyName="s" /> to add the server.
            </Text>
          ) : null}
          {formError ? <Text color="red">{formError}</Text> : null}
          {submitting ? <ActivityIndicator label="Saving header..." /> : null}
        </Box>
      </Box>
    );
  }

  if (mode === 'header-key') {
    return (
      <Box flexDirection="column">
        <Box marginTop={1}>
          <Text>
            Name:{' '}
            <TextInput
              value={pendingHeaderKey}
              onChange={(value) => {
                setPendingHeaderKey(value);
                setFormError(undefined);
              }}
              placeholder="Authorization"
              onSubmit={continueHeaderEntry}
              showCursor
            />
          </Text>
        </Box>
        {formError ? <Text color="red">{formError}</Text> : null}
      </Box>
    );
  }

  if (mode === 'header-value') {
    return (
      <Box flexDirection="column">
        <Box marginTop={1}>
          <Text>
            Value:{' '}
            <TextInput
              value={pendingHeaderValue}
              onChange={(value) => {
                setPendingHeaderValue(value);
                setFormError(undefined);
              }}
              placeholder="Bearer token"
              onSubmit={() => void commitHeaderEntry()}
              mask="*"
              showCursor
              focus={!submitting}
            />
          </Text>
        </Box>
        {formError ? <Text color="red">{formError}</Text> : null}
        {submitting ? <ActivityIndicator label="Saving header..." /> : null}
      </Box>
    );
  }

  if (mode === 'edit-http' && selectedServer) {
    return (
      <Box marginTop={1} flexDirection="column">
        <MenuList
          items={[
            { label: 'URL', value: 'url' },
            {
              label: `Headers (${pendingHeaders.length})`,
              value: 'headers',
            },
          ]}
          selectedIndex={highlightedEditOption}
          visibleCount={2}
          onHighlight={(item) =>
            setHighlightedEditOption(item.value === 'url' ? 0 : 1)
          }
          onSelect={(item) =>
            setMode(item.value === 'url' ? 'edit-url' : 'edit-headers')
          }
        />
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
              onChange={(value) => {
                setPendingUrl(value);
                setFormError(undefined);
              }}
              placeholder="http://localhost:3000/mcp"
              onSubmit={async () => {
                try {
                  validateHttpMcpUrl(pendingUrl);
                  setSubmitting(true);
                  await apiClient.updateMcpServer(selectedServer, {
                    url: pendingUrl.trim(),
                  });
                  pushToast('MCP URL updated', 'info');
                  setPendingUrl('');
                  setMode('edit-http');
                  serversPoll.refresh();
                } catch (error) {
                  setFormError(
                    error instanceof Error ? error.message : 'Update failed',
                  );
                } finally {
                  setSubmitting(false);
                }
              }}
              showCursor
              focus={!submitting}
            />
          </Text>
        </Box>
        {formError ? <Text color="red">{formError}</Text> : null}
        {submitting ? <ActivityIndicator label="Saving URL..." /> : null}
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
      <ConfirmationPanel
        title={`Delete "${selectedServer}"`}
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
      >
        This permanently removes the MCP server configuration.
      </ConfirmationPanel>
    );
  }

  // --- Detail mode ---

  if (mode === 'detail' && selectedServer && selectedInfo) {
    return (
      <Box flexDirection="column">
        <Box marginTop={1} flexDirection="column">
          <DetailList labelWidth={20}>
            <DetailRow label="name">
              <Text bold>{selectedInfo.name}</Text>
            </DetailRow>
            <DetailRow label="status">
              <McpStatusBadge status={selectedInfo.status} />
            </DetailRow>
            <DetailRow label="transport">{selectedInfo.transport}</DetailRow>
            <DetailRow label="tools">{selectedInfo.toolCount}</DetailRow>
            {selectedInfo.transport === 'http' ? (
              <DetailRow label="headers">
                {(selectedInfo.headerNames ?? []).join(', ') || 'none'}
              </DetailRow>
            ) : null}
            <DetailRow label="push notifications">
              {selectedInfo.supportsPushNotifications ? 'yes' : 'no'}
            </DetailRow>
          </DetailList>
          <Box marginTop={1}>
            <Text dimColor>
              Press <KeyHint keyName="e" /> to edit, <KeyHint keyName="d" /> to
              delete, <KeyHint keyName="esc" /> to go back
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
  const highlightedServerIndex = Math.max(
    0,
    servers.findIndex((server) => server.name === highlightedServer),
  );

  return (
    <Box flexDirection="column">
      <Box marginTop={1} flexDirection="column">
        {serversPoll.loading && (
          <ActivityIndicator label="Loading MCP servers..." />
        )}
        {!serversPoll.loading && servers.length === 0 && (
          <EmptyState>No MCP servers configured.</EmptyState>
        )}
        {servers.length > 0 && (
          <MenuList
            items={items}
            selectedIndex={highlightedServerIndex}
            visibleCount={10}
            onHighlight={(item) => setHighlightedServer(item.value)}
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
