import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import { useEffect, useState } from 'react';

import {
  type AdminApiClient,
  AdminApiClientError,
  entryToModelId,
  type ModelSelection,
} from '../api-client';
import { useScreenMeta } from '../hooks/use-screen-meta';
import { useTextInputActive } from '../hooks/use-text-input-active';
import { useToast } from '../hooks/use-toast';
import { MenuKeys, useMenuInput } from '../menu-keys';

export interface ModelSelectionScreenProps {
  apiClient: AdminApiClient;
  onBack: () => void;
}

interface MenuItem {
  label: string;
  value: string;
}

type Purpose =
  | 'chat'
  | 'compaction'
  | 'memory'
  | 'imageVision'
  | 'audioListening'
  | 'voice.sts'
  | 'voice.tts'
  | 'voice.stt';

const PURPOSES: { key: Purpose; label: string }[] = [
  { key: 'chat', label: 'Chat' },
  { key: 'compaction', label: 'Compaction' },
  { key: 'memory', label: 'Memory' },
  { key: 'imageVision', label: 'Image Vision' },
  { key: 'audioListening', label: 'Audio Listening' },
  { key: 'voice.sts', label: 'Voice — Speech-to-Speech' },
  { key: 'voice.tts', label: 'Voice — Text-to-Speech' },
  { key: 'voice.stt', label: 'Voice — Speech-to-Text' },
];

type Mode = 'list' | 'detail' | 'add-model' | 'delete-confirm';

export function ModelSelectionScreen({
  apiClient,
  onBack,
}: ModelSelectionScreenProps) {
  const { pushToast } = useToast();
  const { setMeta } = useScreenMeta();
  const { setActive } = useTextInputActive();
  const [mode, setMode] = useState<Mode>('list');
  const [selectedPurpose, setSelectedPurpose] = useState<Purpose | null>(null);
  const [pendingModelId, setPendingModelId] = useState('');
  const [selection, setSelection] = useState<ModelSelection | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiClient
      .getModelSelection()
      .then((data) => {
        if (!cancelled) {
          setSelection(data);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          pushToast(
            err instanceof AdminApiClientError
              ? err.message
              : 'Failed to load model selection',
            'error',
          );
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [apiClient, pushToast]);

  useEffect(() => {
    setActive(mode === 'add-model');
  }, [mode, setActive]);

  useEffect(() => {
    const titles: Record<Mode, string> = {
      list: 'Model Selection',
      detail: `Model Selection — ${selectedPurpose ?? ''}`,
      'add-model': `Add Model — ${selectedPurpose ?? ''}`,
      'delete-confirm': `Delete Model — ${selectedPurpose ?? ''}`,
    };
    const keysByMode: Record<Mode, { key: string; label: string }[]> = {
      list: [
        { key: 'enter', label: 'View' },
        { key: 'esc', label: 'Back' },
      ],
      detail: [
        { key: 'a', label: 'Add' },
        { key: 'd', label: 'Delete' },
        { key: 'esc', label: 'Back' },
      ],
      'add-model': [
        { key: 'enter', label: 'Add' },
        { key: 'esc', label: 'Cancel' },
      ],
      'delete-confirm': [
        { key: 'y', label: 'Confirm' },
        { key: 'n', label: 'Cancel' },
      ],
    };
    setMeta({
      title: titles[mode],
      breadcrumb: ['Home', 'Settings'],
      keys: keysByMode[mode],
    });
  }, [setMeta, mode, selectedPurpose]);

  useMenuInput({
    [MenuKeys.Back]: () => {
      if (mode === 'list') onBack();
      else if (mode === 'detail') {
        setMode('list');
        setSelectedPurpose(null);
      } else setMode('detail');
    },
    [MenuKeys.Add]: () => {
      if (mode === 'detail') {
        setPendingModelId('');
        setMode('add-model');
      }
    },
    [MenuKeys.Delete]: () => {
      if (mode === 'detail') setMode('delete-confirm');
    },
  });

  function getModels(purpose: Purpose): string[] {
    if (!selection) return [];
    if (purpose.startsWith('voice.')) {
      const voiceKey = purpose.split('.')[1] as 'sts' | 'tts' | 'stt';
      return selection.voice[voiceKey];
    }
    return (
      selection[purpose as Exclude<Purpose, `voice.${string}`>] ?? []
    ).map(entryToModelId);
  }

  async function patchPurpose(
    purpose: Purpose,
    modelIds: string[],
  ): Promise<boolean> {
    if (!selection) return false;
    let patchBody: Record<string, unknown>;
    if (purpose.startsWith('voice.')) {
      const voiceKey = purpose.split('.')[1] as 'sts' | 'tts' | 'stt';
      patchBody = {
        voice: {
          sts: selection.voice.sts,
          tts: selection.voice.tts,
          stt: selection.voice.stt,
          [voiceKey]: modelIds,
        },
      };
    } else {
      patchBody = { [purpose]: modelIds };
    }
    try {
      const updated = await apiClient.patchModelSelection(patchBody);
      setSelection(updated);
      if (updated.warnings && updated.warnings.length > 0) {
        for (const w of updated.warnings) {
          pushToast(`Warning: ${w.message}`, 'error');
        }
      }
      return true;
    } catch (err) {
      pushToast(
        err instanceof AdminApiClientError ? err.message : 'Update failed',
        'error',
      );
      return false;
    }
  }

  // --- Add model mode ---

  if (mode === 'add-model' && selectedPurpose) {
    return (
      <Box flexDirection="column">
        <Box marginTop={1}>
          <Text>
            Model ID (provider:model or provider:endpoint:model):{' '}
            <TextInput
              value={pendingModelId}
              onChange={setPendingModelId}
              placeholder="openai:gpt-4o"
              onSubmit={async () => {
                if (!pendingModelId.trim()) return;
                const current = getModels(selectedPurpose);
                if (current.includes(pendingModelId.trim())) {
                  pushToast('Model already in list', 'error');
                  setMode('detail');
                  return;
                }
                if (
                  await patchPurpose(selectedPurpose, [
                    ...current,
                    pendingModelId.trim(),
                  ])
                ) {
                  pushToast('Model added', 'info');
                  setPendingModelId('');
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

  // --- Delete confirm mode ---

  if (mode === 'delete-confirm' && selectedPurpose) {
    const models = getModels(selectedPurpose);
    if (models.length === 0) {
      setMode('detail');
      return null;
    }
    return (
      <Box flexDirection="column">
        <Box marginTop={1}>
          <Text color="red">
            Delete the last model "{models[models.length - 1]}"? [y/n]
          </Text>
        </Box>
        <ConfirmInput
          onConfirm={async () => {
            if (await patchPurpose(selectedPurpose, models.slice(0, -1))) {
              pushToast('Model removed', 'info');
              setMode('detail');
            }
          }}
          onCancel={() => setMode('detail')}
        />
      </Box>
    );
  }

  // --- Detail mode ---

  if (mode === 'detail' && selectedPurpose) {
    const models = getModels(selectedPurpose);
    const purposeLabel = PURPOSES.find((p) => p.key === selectedPurpose)?.label;
    return (
      <Box flexDirection="column">
        <Box marginTop={1} flexDirection="column">
          <Text bold>{purposeLabel}</Text>
          {models.length === 0 && (
            <Text dimColor>No models configured for this purpose.</Text>
          )}
          {models.length > 0 && (
            <Box marginLeft={2} flexDirection="column">
              {models.map((model, idx) => (
                <Box key={model}>
                  <Text dimColor>{idx + 1}. </Text>
                  <Text>{model}</Text>
                  {idx === 0 && <Text dimColor> (primary)</Text>}
                  {idx > 0 && <Text dimColor> (fallback #{idx})</Text>}
                </Box>
              ))}
            </Box>
          )}
          <Box marginTop={1}>
            <Text dimColor>[a] Add model | [d] Delete last | [esc] Back</Text>
          </Box>
        </Box>
      </Box>
    );
  }

  // --- List mode ---

  const items: MenuItem[] = PURPOSES.map((p) => {
    const models = getModels(p.key);
    const preview = models.length > 0 ? models[0] : '—';
    return {
      label: `${p.label} (${models.length} model${models.length === 1 ? '' : 's'}) — ${preview}`,
      value: p.key,
    };
  });

  return (
    <Box flexDirection="column">
      <Box marginTop={1} flexDirection="column">
        {loading && <Text dimColor>Loading...</Text>}
        {!loading &&
          selection &&
          selection.warnings &&
          selection.warnings.length > 0 && (
            <Box marginBottom={1}>
              <Text color="yellow">
                {selection.warnings.length} warning(s) — see toast messages
              </Text>
            </Box>
          )}
        {!loading && (
          <SelectInput
            items={items}
            onSelect={(item) => {
              setSelectedPurpose(item.value as Purpose);
              setMode('detail');
            }}
          />
        )}
      </Box>
    </Box>
  );
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
