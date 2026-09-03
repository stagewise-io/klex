import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import { useEffect, useState } from 'react';

import {
  type AdminApiClient,
  AdminApiClientError,
  type EndpointsResponse,
  type ProviderResponse,
} from '../api-client';
import { SecretInput } from '../components/secret-input';
import { usePolling } from '../hooks/use-polling';
import { useScreenMeta } from '../hooks/use-screen-meta';
import { useTextInputActive } from '../hooks/use-text-input-active';
import { useToast } from '../hooks/use-toast';
import { MenuKeys, useMenuInput } from '../menu-keys';

export interface ProvidersScreenProps {
  apiClient: AdminApiClient;
  onBack: () => void;
}

interface ProviderSummary {
  name: string;
  preset: string;
  endpointCount: number;
}

interface MenuItem {
  label: string;
  value: string;
}

function extractProviders(data: ProviderResponse): ProviderSummary[] {
  return data.providers.map((p) => {
    if ('preset' in p) {
      return { name: p.name, preset: p.preset, endpointCount: 0 };
    }
    return {
      name: p.name,
      preset: 'custom',
      endpointCount: Object.keys(p.endpoints ?? {}).length,
    };
  });
}

export function ProvidersScreen({ apiClient, onBack }: ProvidersScreenProps) {
  const { pushToast } = useToast();
  const { setMeta } = useScreenMeta();
  const { setActive } = useTextInputActive();
  const [mode, setMode] = useState<
    'list' | 'detail' | 'add-form' | 'add-secret'
  >('list');
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [pendingProviderName, setPendingProviderName] = useState('');

  const providersPoll = usePolling<ProviderResponse>(
    () => apiClient.getProviders(),
    5000,
  );

  useEffect(() => {
    if (providersPoll.error) {
      pushToast(
        `Failed to load providers: ${providersPoll.error.message}`,
        'error',
      );
    }
  }, [providersPoll.error, pushToast]);

  useEffect(() => {
    setActive(mode === 'add-form' || mode === 'add-secret');
  }, [mode, setActive]);

  useEffect(() => {
    const titles = {
      list: 'Providers & Endpoints',
      detail: `Provider: ${selectedProvider}`,
      'add-form': 'Add Provider',
      'add-secret': 'Add Provider — API Key',
    } as const;
    const keysByMode: Record<
      'list' | 'detail' | 'add-form' | 'add-secret',
      { key: string; label: string }[]
    > = {
      list: [
        { key: 'a', label: 'Add' },
        { key: 'enter', label: 'View' },
        { key: 'esc', label: 'Back' },
      ],
      detail: [
        { key: 'd', label: 'Delete' },
        { key: 'e', label: 'Update Key' },
        { key: 'esc', label: 'Back' },
      ],
      'add-form': [
        { key: 'enter', label: 'Next' },
        { key: 'esc', label: 'Cancel' },
      ],
      'add-secret': [{ key: 'esc', label: 'Cancel' }],
    };
    setMeta({
      title: titles[mode],
      breadcrumb: ['Home', 'Settings'],
      keys: keysByMode[mode],
    });
  }, [setMeta, mode, selectedProvider]);

  useMenuInput({
    [MenuKeys.Back]: () => {
      if (mode === 'list') onBack();
      else setMode('list');
    },
    [MenuKeys.Add]: () => {
      if (mode === 'list') setMode('add-form');
    },
  });

  const providers = providersPoll.data
    ? extractProviders(providersPoll.data)
    : [];

  if (mode === 'add-form') {
    return (
      <AddProviderForm
        onCancel={() => setMode('list')}
        onSubmit={(name) => {
          setPendingProviderName(name);
          setMode('add-secret');
        }}
      />
    );
  }

  if (mode === 'add-secret') {
    return (
      <Box flexDirection="column">
        <Box marginTop={1}>
          <SecretInput
            label="API Key"
            placeholder="Enter API key (will be redacted)..."
            onSubmit={async (apiKey) => {
              try {
                await apiClient.createProvider({
                  name: pendingProviderName,
                  preset: 'custom',
                  auth: { apiKey },
                });
                setMode('list');
                providersPoll.refresh();
                pushToast('Provider added successfully', 'info');
              } catch (err) {
                const msg =
                  err instanceof AdminApiClientError
                    ? err.message
                    : 'Failed to add provider';
                pushToast(msg, 'error');
                setMode('list');
              }
            }}
          />
        </Box>
      </Box>
    );
  }

  if (mode === 'detail' && selectedProvider) {
    return (
      <ProviderDetail
        apiClient={apiClient}
        providerName={selectedProvider}
        onBack={() => {
          setMode('list');
          setSelectedProvider(null);
        }}
      />
    );
  }

  // List mode
  const items: MenuItem[] = providers.map((p) => ({
    label: `${p.name} (${p.preset}) — ${p.endpointCount} endpoint${p.endpointCount === 1 ? '' : 's'}`,
    value: p.name,
  }));

  return (
    <Box flexDirection="column">
      <Box marginTop={1} flexDirection="column">
        {providersPoll.loading && <Text dimColor>Loading...</Text>}
        {!providersPoll.loading && providers.length === 0 && (
          <Text dimColor>No providers configured.</Text>
        )}
        {providers.length > 0 && (
          <SelectInput
            items={items}
            onSelect={(item) => {
              setSelectedProvider(item.value);
              setMode('detail');
            }}
          />
        )}
      </Box>
    </Box>
  );
}

function AddProviderForm({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState('');
  useMenuInput({
    [MenuKeys.Back]: onCancel,
  });
  return (
    <Box flexDirection="column">
      <Box marginTop={1}>
        <Text>
          Name:{' '}
          <TextInput
            value={name}
            onChange={setName}
            placeholder="provider-name"
            onSubmit={() => {
              if (name.trim()) onSubmit(name.trim());
            }}
            showCursor
          />
        </Text>
      </Box>
    </Box>
  );
}

function ProviderDetail({
  apiClient,
  providerName,
  onBack,
}: {
  apiClient: AdminApiClient;
  providerName: string;
  onBack: () => void;
}) {
  const { pushToast } = useToast();
  const { setMeta } = useScreenMeta();
  const { setActive } = useTextInputActive();
  const [mode, setMode] = useState<'view' | 'delete-confirm' | 'update-secret'>(
    'view',
  );
  const endpointsPoll = usePolling<EndpointsResponse>(
    () => apiClient.getEndpoints(providerName),
    5000,
  );

  useEffect(() => {
    if (endpointsPoll.error) {
      pushToast(
        `Failed to load endpoints: ${endpointsPoll.error.message}`,
        'error',
      );
    }
  }, [endpointsPoll.error, pushToast]);

  useEffect(() => {
    setActive(mode === 'update-secret');
  }, [mode, setActive]);

  useEffect(() => {
    const titles = {
      view: `Provider: ${providerName}`,
      'delete-confirm': `Delete "${providerName}"`,
      'update-secret': `Update API Key — ${providerName}`,
    } as const;
    const keysByMode: Record<
      'view' | 'delete-confirm' | 'update-secret',
      { key: string; label: string }[]
    > = {
      view: [
        { key: 'd', label: 'Delete' },
        { key: 'e', label: 'Update Key' },
        { key: 'esc', label: 'Back' },
      ],
      'delete-confirm': [
        { key: 'y', label: 'Confirm' },
        { key: 'n', label: 'Cancel' },
      ],
      'update-secret': [{ key: 'esc', label: 'Cancel' }],
    };
    setMeta({
      title: titles[mode],
      breadcrumb: ['Home', 'Settings', 'Providers'],
      keys: keysByMode[mode],
    });
  }, [setMeta, mode, providerName]);

  useMenuInput({
    [MenuKeys.Back]: () => {
      if (mode === 'view') onBack();
      else setMode('view');
    },
    [MenuKeys.Delete]: () => {
      if (mode === 'view') setMode('delete-confirm');
    },
  });

  if (mode === 'delete-confirm') {
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
              await apiClient.deleteProvider(providerName);
              pushToast('Provider deleted', 'info');
              onBack();
            } catch (err) {
              pushToast(
                err instanceof AdminApiClientError
                  ? err.message
                  : 'Delete failed',
                'error',
              );
              setMode('view');
            }
          }}
          onCancel={() => setMode('view')}
        />
      </Box>
    );
  }

  if (mode === 'update-secret') {
    return (
      <Box flexDirection="column">
        <Box marginTop={1}>
          <SecretInput
            label="New API Key"
            placeholder="Enter new API key (will be redacted)..."
            onSubmit={async (apiKey) => {
              try {
                await apiClient.updateProvider(providerName, {
                  auth: { apiKey },
                });
                pushToast('API key updated', 'info');
                setMode('view');
              } catch (err) {
                pushToast(
                  err instanceof AdminApiClientError
                    ? err.message
                    : 'Update failed',
                  'error',
                );
                setMode('view');
              }
            }}
          />
        </Box>
      </Box>
    );
  }

  const endpoints = endpointsPoll.data?.endpoints ?? [];

  return (
    <Box flexDirection="column">
      <Box marginTop={1} flexDirection="column">
        <Text bold>Endpoints</Text>
        {endpointsPoll.loading && <Text dimColor>Loading...</Text>}
        {!endpointsPoll.loading && endpoints.length === 0 && (
          <Text dimColor>No endpoints configured.</Text>
        )}
        {endpoints.length > 0 && (
          <Box flexDirection="column" marginLeft={2}>
            {endpoints.map((ep) => (
              <Box key={ep.name} flexDirection="column">
                <Text>
                  <Text bold>{ep.name}</Text>
                  <Text dimColor> ({ep.format})</Text>
                </Text>
                <Text dimColor> {ep.url}</Text>
                <Text dimColor>
                  {' '}
                  auth: {ep.auth.apiKey ? '••••••••' : 'none'}
                </Text>
              </Box>
            ))}
          </Box>
        )}
      </Box>
      <UpdateKeyHint onEdit={() => setMode('update-secret')} />
    </Box>
  );
}

function UpdateKeyHint({ onEdit }: { onEdit: () => void }) {
  useMenuInput({ [MenuKeys.Edit]: onEdit });
  return null;
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
