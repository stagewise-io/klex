import { Box, Text, useInput } from 'ink';
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
import { ActivityIndicator } from '../components/activity-indicator';
import { ConfirmationPanel } from '../components/confirmation-panel';
import { EmptyState } from '../components/empty-state';
import { MenuList } from '../components/menu-list';
import { ScrollableBox } from '../components/scrollable-box';
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

function fuzzyIncludes(value: string, query: string): boolean {
  let queryIndex = 0;
  for (const character of value.toLowerCase()) {
    if (character === query[queryIndex]) queryIndex += 1;
    if (queryIndex === query.length) return true;
  }
  return query.length === 0;
}

export function matchesModelSearch(model: KnownModel, query: string): boolean {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const fields = [model.displayName ?? '', model.modelId];
  return terms.every((term) =>
    fields.some((field) => fuzzyIncludes(field, term)),
  );
}

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
  const [highlightedProviderId, setHighlightedProviderId] = useState<string>();
  const [selectedProvider, setSelectedProvider] = useState<ProviderInfo>();
  const [availableModels, setAvailableModels] =
    useState<KnownModelsResponse['models']>();
  const [modelSearch, setModelSearch] = useState('');
  const [modelFilterFocused, setModelFilterFocused] = useState(false);
  const [highlightedModelKey, setHighlightedModelKey] = useState<string>();
  const [selection, setSelection] = useState<ModelSelection | null>(null);
  const [detailIndex, setDetailIndex] = useState(0);
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
    setActive(
      mode === 'add-manual' || (mode === 'choose-model' && modelFilterFocused),
    );
  }, [mode, modelFilterFocused, setActive]);

  useEffect(() => {
    const titles: Record<Mode, string> = {
      list: 'Model Selection',
      detail: `Model Selection — ${selectedPurpose ?? ''}`,
      'choose-provider': `Choose Provider — ${selectedPurpose ?? ''}`,
      'choose-model': `Choose Model — ${selectedPurpose ?? ''}`,
      'add-manual': `Add Manual Model — ${selectedPurpose ?? ''}`,
      'delete-confirm': `Delete Model — ${selectedPurpose ?? ''}`,
    };
    let detailModelCount = 0;
    if (selectedPurpose && selection) {
      detailModelCount = selectedPurpose.startsWith('voice.')
        ? selection.voice[
            selectedPurpose.split('.')[1] as 'sts' | 'tts' | 'stt'
          ].length
        : selection[selectedPurpose as Exclude<Purpose, `voice.${string}`>]
            .length;
    }
    const detailKeys = [{ key: 'a', label: 'Add' }];
    if (detailIndex > 0) detailKeys.push({ key: 'shift+↑', label: 'Move up' });
    if (detailIndex < detailModelCount - 1)
      detailKeys.push({ key: 'shift+↓', label: 'Move down' });
    if (detailModelCount > 0)
      detailKeys.push({ key: 'd', label: 'Delete last' });
    detailKeys.push({ key: 'esc', label: 'Back' });

    const keysByMode: Record<Mode, { key: string; label: string }[]> = {
      list: [
        { key: 'enter', label: 'View' },
        { key: 'esc', label: 'Back' },
      ],
      detail: detailKeys,
      'choose-provider': [{ key: 'esc', label: 'Cancel' }],
      'choose-model': [
        { key: '/', label: 'Filter' },
        { key: 'esc', label: 'Providers' },
      ],
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
  }, [setMeta, mode, selectedPurpose, selection, detailIndex]);

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
        setHighlightedProviderId(undefined);
        setSelectedProvider(undefined);
        setAvailableModels(undefined);
        setModelSearch('');
        setHighlightedModelKey(undefined);
        setMode('choose-provider');
      }
    },
    [MenuKeys.Delete]: () => {
      if (mode === 'detail') setMode('delete-confirm');
    },
    '/': () => {
      if (mode === 'choose-model') setModelFilterFocused(true);
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
          pushToast(w.message, 'warning');
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

  async function moveHighlightedModel(offset: -1 | 1): Promise<void> {
    if (!selectedPurpose) return;
    const current = getModels(selectedPurpose);
    const from = Math.min(detailIndex, current.length - 1);
    const to = from + offset;
    if (from < 0 || to < 0 || to >= current.length) return;
    const reordered = [...current];
    const [moved] = reordered.splice(from, 1);
    if (!moved) return;
    reordered.splice(to, 0, moved);
    setDetailIndex(to);
    if (await patchPurpose(selectedPurpose, reordered)) {
      pushToast('Model priority updated', 'info');
    } else {
      setDetailIndex(from);
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
      setDetailIndex(current.length);
      setPendingModelId('');
      setMode('detail');
    }
  }

  if (mode === 'choose-provider' && selectedPurpose) {
    const highlightedProviderIndex = Math.max(
      0,
      providers.findIndex((provider) => provider.id === highlightedProviderId),
    );
    return (
      <MenuList
        items={providers.map((provider) => ({
          label: `${provider.metadata.displayName} (${provider.id})`,
          value: provider.id,
        }))}
        selectedIndex={highlightedProviderIndex}
        visibleCount={10}
        onHighlight={(item) => setHighlightedProviderId(item.value)}
        onSelect={async (item) => {
          const provider = providers.find(({ id }) => id === item.value);
          if (!provider) return;
          const request = ++modelsRequest.current;
          setSelectedProvider(provider);
          setAvailableModels(undefined);
          setModelSearch('');
          setModelFilterFocused(false);
          setHighlightedModelKey(undefined);
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
    if (!availableModels) {
      return <ActivityIndicator label="Loading models..." />;
    }
    const matchingModels = availableModels
      .filter((model) => supportsPurpose(model, selectedPurpose))
      .filter((model) => matchesModelSearch(model, modelSearch));
    const items: Array<{
      key: string;
      label: string;
      value: { kind: 'model'; modelId: string } | { kind: 'manual' };
    }> = [
      ...matchingModels.map((model) => {
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
    const highlightedIndex = Math.max(
      0,
      items.findIndex((item) => item.key === highlightedModelKey),
    );
    return (
      <Box flexDirection="column">
        <Box>
          <Text>Filter: </Text>
          <TextInput
            value={modelSearch}
            focus={modelFilterFocused}
            onChange={(value) => {
              setModelSearch(value);
              setHighlightedModelKey(undefined);
            }}
            onSubmit={() => setModelFilterFocused(false)}
            placeholder="press / to filter by name or model ID"
          />
        </Box>
        {items.length === 0 ? (
          <Text dimColor>No matching models.</Text>
        ) : (
          <MenuList
            key={modelSearch}
            items={items}
            selectedIndex={highlightedIndex}
            isFocused={!modelFilterFocused}
            visibleCount={10}
            onHighlight={(item) => setHighlightedModelKey(item.key)}
            onSelect={(item) => {
              if (item.value.kind === 'manual') setMode('add-manual');
              else
                void addModel({
                  providerId: selectedProvider.id,
                  modelId: item.value.modelId,
                });
            }}
          />
        )}
      </Box>
    );
  }

  if (mode === 'add-manual' && selectedPurpose && selectedProvider) {
    return (
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>
          Provider: {selectedProvider.metadata.displayName} (
          {selectedProvider.id})
        </Text>
        <Box>
          <Text>Model ID: </Text>
          <TextInput
            value={pendingModelId}
            onChange={setPendingModelId}
            placeholder="gpt-5.2-codex"
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
      <ConfirmationPanel
        title={`Delete Model — ${selectedPurpose}`}
        onConfirm={async () => {
          if (await patchPurpose(selectedPurpose, models.slice(0, -1))) {
            pushToast('Model removed', 'info');
            setMode('detail');
          }
        }}
        onCancel={() => setMode('detail')}
      >
        Delete the last model "
        {entryToModelId(models[models.length - 1] as ModelSelectionEntry)}"?
      </ConfirmationPanel>
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
            <EmptyState>No models configured for this purpose.</EmptyState>
          )}
          {models.length > 0 && (
            <ScrollableBox
              itemCount={models.length}
              selectedIndex={detailIndex}
            >
              <ModelPriorityList
                models={models}
                selectedIndex={detailIndex}
                onHighlight={setDetailIndex}
                onMove={(offset) => void moveHighlightedModel(offset)}
              />
            </ScrollableBox>
          )}
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
        {loading && <ActivityIndicator label="Loading providers..." />}
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
          <MenuList
            items={items}
            onSelect={(item) => {
              setSelectedPurpose(item.value as Purpose);
              setDetailIndex(0);
              setMode('detail');
            }}
          />
        )}
      </Box>
    </Box>
  );
}

function ModelPriorityList({
  models,
  selectedIndex,
  onHighlight,
  onMove,
}: {
  models: ModelSelectionEntry[];
  selectedIndex: number;
  onHighlight: (index: number) => void;
  onMove: (offset: -1 | 1) => void;
}) {
  useInput((_input, key) => {
    if (key.shift && key.upArrow) {
      onMove(-1);
      return;
    }
    if (key.shift && key.downArrow) {
      onMove(1);
      return;
    }
    if (key.upArrow) onHighlight(Math.max(0, selectedIndex - 1));
    if (key.downArrow)
      onHighlight(Math.min(models.length - 1, selectedIndex + 1));
  });

  return (
    <Box flexDirection="column">
      {models.map((model, index) => (
        <Text key={`${model.providerId}:${model.modelId}`}>
          {index === selectedIndex ? '❯ ' : '  '}
          {index + 1}. {entryToModelId(model)}{' '}
          {index === 0 ? '(primary)' : `(fallback #${index})`}
        </Text>
      ))}
    </Box>
  );
}
