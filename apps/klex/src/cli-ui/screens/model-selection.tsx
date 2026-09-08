import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import { useEffect, useRef, useState } from 'react';

import {
  type AdminApiClient,
  AdminApiClientError,
  entryToModelId,
  type KnownModel,
  type KnownModelsResponse,
  type ModelSelection,
  type ModelSelectionEntry,
  type ProviderInfo,
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

export function containsModelReference(
  entries: readonly ModelSelectionEntry[],
  reference: ModelSelectionEntry,
): boolean {
  return entries.some(
    (entry) =>
      entry.providerId === reference.providerId &&
      entry.modelId === reference.modelId,
  );
}

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

function supportsPurpose(model: KnownModel, purpose: Purpose): boolean {
  if (purpose === 'imageVision')
    return model.capabilities?.input?.image !== undefined;
  if (purpose === 'audioListening')
    return model.capabilities?.input?.audio !== undefined;
  if (purpose.startsWith('voice.')) {
    const voice = purpose.split('.')[1] as 'sts' | 'tts' | 'stt';
    return model.capabilities?.voice?.[voice] === true;
  }
  return (
    model.kind === undefined ||
    model.kind === 'unknown' ||
    model.kind === 'language'
  );
}

type Mode =
  | 'list'
  | 'detail'
  | 'choose-provider'
  | 'choose-model'
  | 'add-manual'
  | 'delete-confirm';

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
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<ProviderInfo>();
  const [availableModels, setAvailableModels] =
    useState<KnownModelsResponse['models']>();
  const [selection, setSelection] = useState<ModelSelection | null>(null);
  const [loading, setLoading] = useState(true);
  const modelsRequest = useRef(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiClient
      .getModelSelection()
      .then((data) => {
        if (!cancelled) {
          setSelection(data);
          setLoading(false);
          void apiClient
            .getProviders()
            .then((response) => {
              if (!cancelled) setProviders(response.providers);
            })
            .catch((error) => {
              if (!cancelled)
                pushToast(
                  error instanceof Error
                    ? error.message
                    : 'Failed to load providers',
                  'error',
                );
            });
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
    setActive(mode === 'add-manual');
  }, [mode, setActive]);

  useEffect(() => {
    const titles: Record<Mode, string> = {
      list: 'Model Selection',
      detail: `Model Selection — ${selectedPurpose ?? ''}`,
      'choose-provider': `Choose Provider — ${selectedPurpose ?? ''}`,
      'choose-model': `Choose Model — ${selectedPurpose ?? ''}`,
      'add-manual': `Add Manual Model — ${selectedPurpose ?? ''}`,
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
      'choose-provider': [{ key: 'esc', label: 'Cancel' }],
      'choose-model': [{ key: 'esc', label: 'Providers' }],
      'add-manual': [
        { key: 'enter', label: 'Add' },
        { key: 'esc', label: 'Models' },
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
      } else if (mode === 'add-manual') setMode('choose-model');
      else if (mode === 'choose-model') {
        modelsRequest.current += 1;
        setMode('choose-provider');
      } else setMode('detail');
    },
    [MenuKeys.Add]: () => {
      if (mode === 'detail') {
        setPendingModelId('');
        setSelectedProvider(undefined);
        setAvailableModels(undefined);
        setMode('choose-provider');
      }
    },
    [MenuKeys.Delete]: () => {
      if (mode === 'detail') setMode('delete-confirm');
    },
  });

  function getModels(purpose: Purpose): ModelSelectionEntry[] {
    if (!selection) return [];
    if (purpose.startsWith('voice.')) {
      const voiceKey = purpose.split('.')[1] as 'sts' | 'tts' | 'stt';
      return selection.voice[voiceKey];
    }
    return selection[purpose as Exclude<Purpose, `voice.${string}`>] ?? [];
  }

  async function patchPurpose(
    purpose: Purpose,
    references: ModelSelectionEntry[],
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
          [voiceKey]: references,
        },
      };
    } else {
      patchBody = { [purpose]: references };
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

  async function addModel(reference: ModelSelectionEntry): Promise<void> {
    if (!selectedPurpose) return;
    const current = getModels(selectedPurpose);
    if (containsModelReference(current, reference)) {
      pushToast('Model already in list', 'error');
      setMode('detail');
      return;
    }
    if (await patchPurpose(selectedPurpose, [...current, reference])) {
      pushToast('Model added', 'info');
      setPendingModelId('');
      setMode('detail');
    }
  }

  if (mode === 'choose-provider' && selectedPurpose) {
    return (
      <SelectInput
        items={providers.map((provider) => ({
          label: `${provider.metadata.displayName} (${provider.id})`,
          value: provider.id,
        }))}
        onSelect={async (item) => {
          const provider = providers.find(({ id }) => id === item.value);
          if (!provider) return;
          const request = ++modelsRequest.current;
          setSelectedProvider(provider);
          setAvailableModels(undefined);
          setMode('choose-model');
          try {
            const result = await apiClient.getKnownModels(provider.id);
            if (modelsRequest.current !== request) return;
            setAvailableModels(result.models);
          } catch (error) {
            if (modelsRequest.current !== request) return;
            pushToast(
              error instanceof Error ? error.message : 'Failed to load models',
              'error',
            );
            setAvailableModels([]);
          }
        }}
      />
    );
  }

  if (mode === 'choose-model' && selectedPurpose && selectedProvider) {
    if (!availableModels) return <Text dimColor>Loading models...</Text>;
    const items: Array<{
      key: string;
      label: string;
      value: { kind: 'model'; modelId: string } | { kind: 'manual' };
    }> = [
      ...availableModels
        .filter((model) => supportsPurpose(model, selectedPurpose))
        .map((model) => {
          const inferred = model.provenance?.some(({ source }) =>
            ['shared-catalog', 'provider-family'].includes(source),
          );
          return {
            key: `model:${model.modelId}`,
            label: `${model.displayName ?? model.modelId} — ${model.modelId} (${model.source}${inferred ? ', inferred' : ''})`,
            value: { kind: 'model' as const, modelId: model.modelId },
          };
        }),
      ...(selectedProvider.metadata.capabilities.customModels
        ? [
            {
              key: 'manual',
              label: 'Enter a manual model ID…',
              value: { kind: 'manual' as const },
            },
          ]
        : []),
    ];
    return items.length === 0 ? (
      <Text dimColor>This provider reports no available models.</Text>
    ) : (
      <SelectInput
        items={items}
        onSelect={(item) => {
          if (item.value.kind === 'manual') setMode('add-manual');
          else
            void addModel({
              providerId: selectedProvider.id,
              modelId: item.value.modelId,
            });
        }}
      />
    );
  }

  if (mode === 'add-manual' && selectedPurpose && selectedProvider) {
    return (
      <Box marginTop={1}>
        <Text>Native model ID: </Text>
        <TextInput
          value={pendingModelId}
          onChange={setPendingModelId}
          placeholder="provider-native/model:id"
          onSubmit={() => {
            const modelId = pendingModelId.trim();
            if (!modelId) return;
            void apiClient
              .createKnownModel(selectedProvider.id, {
                modelId,
                displayName: modelId,
              })
              .then(() =>
                addModel({ providerId: selectedProvider.id, modelId }),
              )
              .catch((error) =>
                pushToast(
                  error instanceof Error
                    ? error.message
                    : 'Failed to persist manual model',
                  'error',
                ),
              );
          }}
          showCursor
        />
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
            Delete the last model "
            {entryToModelId(models[models.length - 1] as ModelSelectionEntry)}"?
            [y/n]
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
                <Box key={`${model.providerId}:${model.modelId}`}>
                  <Text dimColor>{idx + 1}. </Text>
                  <Text>{entryToModelId(model)}</Text>
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
    const preview =
      models.length > 0
        ? entryToModelId(models[0] as ModelSelectionEntry)
        : '—';
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
