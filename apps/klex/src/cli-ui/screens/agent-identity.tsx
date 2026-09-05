import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { useEffect, useRef, useState } from 'react';

import {
  type AdminApiClient,
  AdminApiClientError,
  type AgentIdentity,
} from '../api-client';
import { ScreenSection } from '../components/screen-section';
import { useScreenMeta } from '../hooks/use-screen-meta';
import { useTextInputActive } from '../hooks/use-text-input-active';
import { useToast } from '../hooks/use-toast';
import { MenuKeys, useMenuInput } from '../menu-keys';

export interface AgentIdentityScreenProps {
  apiClient: AdminApiClient;
  onBack: () => void;
}

type Mode = 'view' | 'edit';

const MIN_NAME = 2;
const MAX_NAME = 128;

export function AgentIdentityScreen({
  apiClient,
  onBack,
}: AgentIdentityScreenProps) {
  const { pushToast } = useToast();
  const { setMeta } = useScreenMeta();
  const { setActive } = useTextInputActive();
  const [mode, setMode] = useState<Mode>('view');
  const [identity, setIdentity] = useState<AgentIdentity | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingName, setPendingName] = useState('');
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    apiClient
      .getAgentIdentity()
      .then((data) => {
        if (!cancelled) {
          setIdentity(data);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          const message =
            err instanceof AdminApiClientError
              ? err.message
              : 'Failed to load agent identity';
          setLoadError(message);
          pushToast(message, 'error');
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [apiClient, pushToast]);

  useEffect(() => {
    setActive(mode === 'edit' && !saving);
  }, [mode, saving, setActive]);

  useEffect(() => {
    setMeta({
      title: mode === 'edit' ? 'Agent Identity — Edit' : 'Agent Identity',
      breadcrumb: ['Home', 'Settings'],
      keys:
        mode === 'view'
          ? [
              { key: 'e', label: 'Edit' },
              { key: 'esc', label: 'Back' },
            ]
          : saving
            ? []
            : [
                { key: 'enter', label: 'Save' },
                { key: 'esc', label: 'Cancel' },
              ],
    });
  }, [setMeta, mode, saving]);

  useMenuInput({
    [MenuKeys.Back]: () => {
      if (savingRef.current) return;
      if (mode === 'view') onBack();
      else setMode('view');
    },
    [MenuKeys.Edit]: () => {
      if (mode === 'view' && identity) {
        setPendingName(identity.officialName);
        setMode('edit');
      }
    },
  });

  async function saveName() {
    if (savingRef.current) return;

    const trimmed = pendingName.trim();
    if (trimmed.length < MIN_NAME) {
      pushToast(`Name must be at least ${MIN_NAME} characters`, 'error');
      return;
    }
    if (Array.from(trimmed).length > MAX_NAME) {
      pushToast(`Name must be at most ${MAX_NAME} characters`, 'error');
      return;
    }

    savingRef.current = true;
    setSaving(true);
    try {
      const updated = await apiClient.patchAgentIdentity({
        officialName: trimmed,
      });
      setIdentity(updated);
      pushToast('Agent name updated', 'info');
      setMode('view');
    } catch (err) {
      pushToast(
        err instanceof AdminApiClientError ? err.message : 'Update failed',
        'error',
      );
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  if (mode === 'edit') {
    return (
      <Box flexDirection="column">
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>
            Official name ({MIN_NAME}–{MAX_NAME} characters):
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={pendingName}
              onChange={(value) => {
                if (!savingRef.current) setPendingName(value);
              }}
              placeholder="Agent name"
              onSubmit={saveName}
              showCursor={!saving}
            />
          </Box>
          <Box marginTop={1}>
            <Text dimColor>
              {saving ? 'Saving...' : '[enter] Save | [esc] Cancel'}
            </Text>
          </Box>
        </Box>
      </Box>
    );
  }

  return (
    <ScreenSection title="Agent Identity">
      {loading && <Text dimColor>Loading...</Text>}
      {!loading && loadError && !identity && (
        <Text color="red">{loadError}</Text>
      )}
      {!loading && identity && (
        <Box flexDirection="column">
          <Box>
            <Text dimColor>Official name: </Text>
            <Text bold>{identity.officialName}</Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>[e] Edit | [esc] Back</Text>
          </Box>
        </Box>
      )}
    </ScreenSection>
  );
}
