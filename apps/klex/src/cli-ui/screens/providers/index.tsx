import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { useEffect, useMemo, useState } from 'react';

import {
  type AdminApiClient,
  AdminApiClientError,
  type KnownModel,
  type ProviderInfo,
  type ProviderResponse,
  type ProviderTypeInfo,
  type ProviderTypesResponse,
} from '../../api-client';
import { ActivityIndicator } from '../../components/activity-indicator';
import { ConfirmationPanel } from '../../components/confirmation-panel';
import { DetailList, DetailRow } from '../../components/detail-list';
import { EmptyState } from '../../components/empty-state';
import { InsetPanel } from '../../components/inset-panel';
import { KeyHint } from '../../components/key-hint';
import { MenuList } from '../../components/menu-list';
import { ScreenSection } from '../../components/screen-section';
import { usePolling } from '../../hooks/use-polling';
import { useScreenMeta } from '../../hooks/use-screen-meta';
import { useTextInputActive } from '../../hooks/use-text-input-active';
import { useToast } from '../../hooks/use-toast';
import { MenuKeys, useMenuInput } from '../../menu-keys';

export interface ProvidersScreenProps {
  apiClient: AdminApiClient;
  onBack: () => void;
}

type Mode =
  | 'list'
  | 'choose-type'
  | 'configure'
  | 'detail'
  | 'models'
  | 'edit'
  | 'add-model'
  | 'edit-model';

export function ProvidersScreen({ apiClient, onBack }: ProvidersScreenProps) {
  const { pushToast } = useToast();
  const { setMeta } = useScreenMeta();
  const { setActive } = useTextInputActive();
  const [mode, setMode] = useState<Mode>('list');
  const [selected, setSelected] = useState<ProviderInfo>();
  const [providerType, setProviderType] = useState<ProviderTypeInfo>();
  const [selectedModel, setSelectedModel] = useState<KnownModel>();
  const [knownModelActions, setKnownModelActions] = useState({
    filterFocused: false,
    modelHighlighted: false,
    manualModelHighlighted: false,
  });
  const providersPoll = usePolling<ProviderResponse>(
    () => apiClient.getProviders(),
    5000,
  );
  const typesPoll = usePolling<ProviderTypesResponse>(
    () => apiClient.getProviderTypes(),
    30000,
  );

  useEffect(
    () =>
      setActive(
        mode === 'configure' ||
          mode === 'edit' ||
          mode === 'add-model' ||
          mode === 'edit-model',
      ),
    [mode, setActive],
  );
  useEffect(() => {
    setMeta({
      title:
        mode === 'list'
          ? 'Model Providers'
          : mode === 'choose-type'
            ? 'Choose Provider Type'
            : mode === 'configure'
              ? `Configure ${providerType?.displayName ?? ''}`
              : mode === 'edit'
                ? `Edit ${selected?.metadata.displayName ?? ''}`
                : mode === 'models'
                  ? `Known Models — ${selected?.metadata.displayName ?? ''}`
                  : mode === 'add-model'
                    ? 'Add Known Model'
                    : mode === 'edit-model'
                      ? 'Edit Known Model'
                      : (selected?.metadata.displayName ?? 'Provider'),
      breadcrumb: ['Home', 'Settings'],
      keys:
        mode === 'list'
          ? [
              { key: 'enter', label: 'Details' },
              { key: 'a', label: 'Add' },
              { key: 'esc', label: 'Back' },
            ]
          : mode === 'models'
            ? knownModelActions.filterFocused
              ? [
                  { key: 'enter', label: 'Finish search' },
                  { key: 'esc', label: 'Back' },
                ]
              : [
                  { key: '/', label: 'Search' },
                  ...(selected?.metadata.capabilities.customModels
                    ? [{ key: 'a', label: 'Add manually' }]
                    : []),
                  ...(selected?.metadata.capabilities.modelDiscovery
                    ? [{ key: 'r', label: 'Refresh' }]
                    : []),
                  ...(knownModelActions.modelHighlighted
                    ? [{ key: 'enter', label: 'Edit / override' }]
                    : []),
                  ...(knownModelActions.manualModelHighlighted
                    ? [{ key: 'd', label: 'Delete override' }]
                    : []),
                  { key: 'esc', label: 'Back' },
                ]
            : [{ key: 'esc', label: 'Back' }],
    });
  }, [knownModelActions, mode, providerType, selected, setMeta]);
  useEffect(() => {
    const error = providersPoll.error ?? typesPoll.error;
    if (error) pushToast(`Failed to load providers: ${error.message}`, 'error');
  }, [providersPoll.error, pushToast, typesPoll.error]);

  useMenuInput({
    [MenuKeys.Back]: () => {
      if (mode === 'list') onBack();
      else if (mode === 'choose-type' || mode === 'detail') setMode('list');
      else if (mode === 'models') setMode('detail');
    },
    [MenuKeys.Add]: () => {
      if (mode === 'list') setMode('choose-type');
      else if (
        mode === 'models' &&
        selected?.metadata.capabilities.customModels
      ) {
        setSelectedModel(undefined);
        setMode('add-model');
      }
    },
  });

  if (mode === 'choose-type') {
    return (
      <ProviderTypePicker
        types={typesPoll.data?.providerTypes ?? []}
        loading={typesPoll.loading}
        onSelect={(type) => {
          setProviderType(type);
          setMode('configure');
        }}
      />
    );
  }

  if (mode === 'configure' && providerType) {
    return (
      <ProviderSetupForm
        type={providerType}
        existingInstanceIds={
          providersPoll.data?.providers.map((provider) => provider.id) ?? []
        }
        onCancel={() => setMode('choose-type')}
        onSubmit={async (id, settings) => {
          try {
            await apiClient.canAddProvider(providerType.type, settings);
            await apiClient.createProvider({
              id,
              type: providerType.type,
              settings,
            });
            providersPoll.refresh();
            setMode('list');
            pushToast('Provider added', 'info');
          } catch (error) {
            pushProviderError(pushToast, error, 'Failed to add provider');
          }
        }}
      />
    );
  }

  if (mode === 'edit' && selected) {
    const selectedType = typesPoll.data?.providerTypes.find(
      (type) => type.type === selected.type,
    );
    if (!selectedType) {
      return (
        <Text dimColor>
          {typesPoll.error
            ? 'Provider metadata unavailable.'
            : 'Loading provider metadata...'}
        </Text>
      );
    }
    return (
      <ProviderSetupForm
        type={selectedType}
        instanceId={selected.id}
        initialSettings={selected.settings}
        onCancel={() => setMode('detail')}
        onSubmit={async (_id, settings) => {
          try {
            const result = await apiClient.updateProvider(selected.id, {
              settings,
            });
            if (result.provider) setSelected(result.provider);
            providersPoll.refresh();
            setMode('detail');
            pushToast('Provider updated', 'info');
          } catch (error) {
            pushProviderError(pushToast, error, 'Failed to update provider');
          }
        }}
      />
    );
  }

  if (mode === 'edit-model' && selected && selectedModel) {
    const createsOverride = selectedModel.source === 'discovered';
    return (
      <KnownModelForm
        model={selectedModel}
        lockModelId
        onCancel={() => setMode('models')}
        onSubmit={async (modelId, definition) => {
          try {
            if (createsOverride) {
              await apiClient.createKnownModel(selected.id, {
                modelId,
                ...definition,
              });
            } else {
              await apiClient.updateKnownModel(
                selected.id,
                modelId,
                definition,
              );
            }
            setMode('models');
            pushToast(
              createsOverride ? 'Model override added' : 'Known model updated',
              'info',
            );
          } catch (error) {
            pushProviderError(pushToast, error, 'Failed to update model');
          }
        }}
      />
    );
  }

  if (mode === 'add-model' && selected) {
    return (
      <KnownModelForm
        onCancel={() => setMode('models')}
        onSubmit={async (modelId, definition) => {
          try {
            await apiClient.createKnownModel(selected.id, {
              modelId,
              ...definition,
            });
            setMode('models');
            pushToast('Known model added', 'info');
          } catch (error) {
            pushProviderError(pushToast, error, 'Failed to add model');
          }
        }}
      />
    );
  }

  if (mode === 'models' && selected) {
    return (
      <KnownModelsPage
        provider={selected}
        apiClient={apiClient}
        onActionStateChange={setKnownModelActions}
        onEditModel={(model) => {
          setSelectedModel(model);
          setMode('edit-model');
        }}
      />
    );
  }

  if (mode === 'detail' && selected) {
    return (
      <ProviderDetail
        provider={selected}
        apiClient={apiClient}
        onDeleted={() => {
          providersPoll.refresh();
          setSelected(undefined);
          setMode('list');
        }}
        onEdit={() => setMode('edit')}
        onManageModels={() => setMode('models')}
      />
    );
  }

  return (
    <ProviderInstanceList
      providers={providersPoll.data?.providers ?? []}
      loading={providersPoll.loading}
      onSelect={(provider) => {
        setSelected(provider);
        setMode('detail');
      }}
    />
  );
}

const PROVIDER_GROUPS = [
  'Direct APIs',
  'Cloud platforms',
  'Gateways & plans',
  'Custom endpoints',
  'Local',
] as const;

type ProviderGroup = (typeof PROVIDER_GROUPS)[number];

const PROVIDER_GROUP_BY_TYPE: Partial<Record<string, ProviderGroup>> = {
  'amazon-bedrock': 'Cloud platforms',
  'azure-openai': 'Cloud platforms',
  'google-vertex': 'Cloud platforms',
  openrouter: 'Gateways & plans',
  'glm-coding-plan': 'Gateways & plans',
  'minimax-coding-plan': 'Gateways & plans',
  'opencode-go': 'Gateways & plans',
  'opencode-zen': 'Gateways & plans',
  'chatgpt-codex-subscription': 'Gateways & plans',
  'chat-completions': 'Custom endpoints',
  responses: 'Custom endpoints',
  'anthropic-messages': 'Custom endpoints',
  'google-generative': 'Custom endpoints',
  ollama: 'Local',
};

export function providerGroup(type: string): ProviderGroup {
  return PROVIDER_GROUP_BY_TYPE[type] ?? 'Direct APIs';
}

function compareProviderTypes(
  left: ProviderTypeInfo,
  right: ProviderTypeInfo,
): number {
  const groupDifference =
    PROVIDER_GROUPS.indexOf(providerGroup(left.type)) -
    PROVIDER_GROUPS.indexOf(providerGroup(right.type));
  return (
    groupDifference ||
    left.displayName.localeCompare(right.displayName) ||
    left.type.localeCompare(right.type)
  );
}

function ProviderTypePicker({
  types,
  loading,
  onSelect,
}: {
  types: ProviderTypeInfo[];
  loading: boolean;
  onSelect: (type: ProviderTypeInfo) => void;
}) {
  const sortedTypes = [...types].sort(compareProviderTypes);
  const [highlightedTypeId, setHighlightedTypeId] = useState<string>();
  const highlightedTypeIndex = Math.max(
    0,
    sortedTypes.findIndex((type) => type.type === highlightedTypeId),
  );
  const highlightedType = sortedTypes[highlightedTypeIndex];

  return (
    <ScreenSection title="Add a model provider">
      <Text dimColor>
        Providers are grouped by how Klex connects to them. Choose one to see
        its setup requirements.
      </Text>
      {loading && <ActivityIndicator label="Loading provider types..." />}
      {!loading && sortedTypes.length === 0 && (
        <Text color="yellow">No provider types are available.</Text>
      )}
      {sortedTypes.length > 0 && (
        <MenuList
          items={sortedTypes.map((type) => ({
            label: `${providerGroup(type.type)} · ${type.displayName}`,
            value: type.type,
          }))}
          selectedIndex={highlightedTypeIndex}
          visibleCount={10}
          onHighlight={(item) => setHighlightedTypeId(item.value)}
          onSelect={(item) => {
            const type = sortedTypes.find(
              (candidate) => candidate.type === item.value,
            );
            if (type) onSelect(type);
          }}
        />
      )}
      {highlightedType && (
        <InsetPanel marginTop={1} height={8} overflow="hidden">
          <Text bold wrap="truncate">
            {highlightedType.displayName}
          </Text>
          <Text wrap="truncate-end">{highlightedType.description}</Text>
          <Text dimColor wrap="truncate">
            {providerCapabilitySummary(highlightedType)}
          </Text>
          {highlightedType.documentationUrl && (
            <Text dimColor wrap="truncate">
              Docs: {highlightedType.documentationUrl}
            </Text>
          )}
        </InsetPanel>
      )}
    </ScreenSection>
  );
}

function providerCapabilitySummary(type: ProviderTypeInfo): string {
  const capabilities = [
    type.capabilities.modelDiscovery ? 'discovers models' : 'manual model IDs',
    type.capabilities.connectivityTest ? 'connection testing' : undefined,
    type.capabilities.customModels ? 'custom models' : undefined,
  ].filter(Boolean);
  return `Supports: ${capabilities.join(' · ')}`;
}

function ProviderInstanceList({
  providers,
  loading,
  onSelect,
}: {
  providers: ProviderInfo[];
  loading: boolean;
  onSelect: (provider: ProviderInfo) => void;
}) {
  const sortedProviders = [...providers].sort(
    (left, right) =>
      left.metadata.displayName.localeCompare(right.metadata.displayName) ||
      left.id.localeCompare(right.id),
  );
  const [highlightedId, setHighlightedId] = useState<string>();
  const highlightedIndex = Math.max(
    0,
    sortedProviders.findIndex((provider) => provider.id === highlightedId),
  );
  const highlighted = sortedProviders[highlightedIndex];

  return (
    <ScreenSection title="Configured model providers">
      <Text dimColor>
        Highlight a provider and press <KeyHint keyName="enter" /> to open its
        details.
      </Text>
      {loading && <ActivityIndicator label="Loading providers..." />}
      {!loading && sortedProviders.length === 0 && (
        <Box marginTop={1}>
          <EmptyState framed>
            No providers configured. Press <KeyHint keyName="a" /> to add one.
          </EmptyState>
        </Box>
      )}
      {sortedProviders.length > 0 && (
        <MenuList
          items={sortedProviders.map((provider) => ({
            label: `${provider.metadata.displayName} · ${provider.id}`,
            value: provider.id,
          }))}
          selectedIndex={highlightedIndex}
          visibleCount={10}
          onHighlight={(item) => setHighlightedId(item.value)}
          onSelect={(item) => {
            const provider = sortedProviders.find(
              (candidate) => candidate.id === item.value,
            );
            if (provider) onSelect(provider);
          }}
        />
      )}
      {highlighted && (
        <InsetPanel marginTop={1} height={6} overflow="hidden">
          <Text bold wrap="truncate">
            {highlighted.metadata.displayName}
          </Text>
          <Text wrap="truncate-end">{highlighted.metadata.description}</Text>
          <Text dimColor wrap="truncate">
            Instance: {highlighted.id} · Type: {highlighted.type}
          </Text>
        </InsetPanel>
      )}
    </ScreenSection>
  );
}

type SetupField = {
  key: string;
  label: string;
  description?: string;
  kind:
    | 'text'
    | 'secret'
    | 'secret-key-value'
    | 'url'
    | 'number'
    | 'boolean'
    | 'select'
    | 'key-value';
  required?: boolean;
  defaultValue?: string | number | boolean;
  placeholder?: string;
  options?: Array<{ label: string; value: string }>;
  condition?: { field: string; equals: string | number | boolean };
};

export function setupFieldsFromSchema(type: ProviderTypeInfo): SetupField[] {
  const variants = schemaVariants(type.settingsSchema);
  const properties = mergedProperties(variants);
  const required = new Set(
    variants.flatMap((variant) =>
      Array.isArray(variant.required)
        ? variant.required.filter(
            (item): item is string => typeof item === 'string',
          )
        : [],
    ),
  );
  return Object.entries(properties).flatMap(([key, value]) => {
    if (value.readOnly === true) return [];
    const options = Array.isArray(value.enum)
      ? value.enum.filter((item): item is string => typeof item === 'string')
      : [];
    const condition = fieldCondition(variants, key);
    return [
      {
        key,
        label: fieldLabel(key),
        ...(typeof value.description === 'string' && {
          description: value.description,
        }),
        kind:
          options.length > 0
            ? 'select'
            : value.type === 'object' && value.writeOnly === true
              ? 'secret-key-value'
              : value.writeOnly === true || value.format === 'password'
                ? 'secret'
                : value.format === 'uri'
                  ? 'url'
                  : value.type === 'number' || value.type === 'integer'
                    ? 'number'
                    : value.type === 'boolean'
                      ? 'boolean'
                      : value.type === 'object'
                        ? 'key-value'
                        : 'text',
        ...(required.has(key) && { required: true }),
        ...((typeof value.default === 'string' ||
          typeof value.default === 'number' ||
          typeof value.default === 'boolean') && {
          defaultValue: value.default,
        }),
        ...(options.length > 0 && {
          options: options.map((option) => ({
            label: fieldLabel(option),
            value: option,
          })),
        }),
        ...(condition && { condition }),
      },
    ];
  });
}

function schemaVariants(
  schema: Record<string, unknown>,
): Record<string, unknown>[] {
  const alternatives = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : undefined;
  return alternatives?.filter(isRecord) ?? [schema];
}

function mergedProperties(
  variants: readonly Record<string, unknown>[],
): Record<string, Record<string, unknown>> {
  const properties = new Map<string, Record<string, unknown>[]>();
  for (const variant of variants) {
    if (!isRecord(variant.properties)) continue;
    for (const [key, property] of Object.entries(variant.properties)) {
      if (!isRecord(property)) continue;
      const entries = properties.get(key) ?? [];
      entries.push(property);
      properties.set(key, entries);
    }
  }
  return Object.fromEntries(
    [...properties].map(([key, entries]) => {
      const merged = { ...entries[0] };
      const values = entries.flatMap((entry) =>
        typeof entry.const === 'string' ? [entry.const] : [],
      );
      if (values.length > 1) {
        delete merged.const;
        merged.enum = [...new Set(values)];
      }
      return [key, merged];
    }),
  );
}

function fieldCondition(
  variants: readonly Record<string, unknown>[],
  key: string,
): SetupField['condition'] | undefined {
  if (variants.length < 2) return undefined;
  const matching = variants.filter(
    (variant) => isRecord(variant.properties) && key in variant.properties,
  );
  if (matching.length === variants.length || matching.length !== 1)
    return undefined;
  const properties = matching[0]?.properties;
  if (!isRecord(properties)) return undefined;
  for (const [field, property] of Object.entries(properties)) {
    if (field !== key && isRecord(property) && property.const !== undefined) {
      const equals = property.const;
      if (
        typeof equals === 'string' ||
        typeof equals === 'number' ||
        typeof equals === 'boolean'
      )
        return { field, equals };
    }
  }
  return undefined;
}

function fieldLabel(value: string): string {
  if (value === 'authMode') return 'Authentication';
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]/g, ' ')
    .replace(/\b(api|id|url|aws|json|adc)\b/gi, (word) => word.toUpperCase());
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function activeSetupFields(
  fields: readonly SetupField[],
  values: Record<string, unknown>,
): SetupField[] {
  return fields.filter(
    (field) =>
      !field.condition ||
      values[field.condition.field] === field.condition.equals,
  );
}

export function parseSetupValue(field: SetupField, raw: string): unknown {
  if (field.kind === 'number') {
    const value = Number(raw);
    if (!Number.isFinite(value))
      throw new Error(`${field.label} must be a number`);
    return value;
  }
  if (field.kind === 'boolean') return raw === 'true';
  if (field.kind === 'secret-key-value') {
    if (!raw.trim()) return {};
    if (raw.trimStart().startsWith('{')) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (
          !isRecord(parsed) ||
          Object.values(parsed).some((value) => typeof value !== 'string')
        )
          throw new Error();
        return parsed;
      } catch {
        throw new Error(
          `${field.label} must be a JSON object of string values`,
        );
      }
    }
    const separator = raw.indexOf('=');
    const key = raw.slice(0, separator).trim();
    if (separator < 1 || !key)
      throw new Error(
        `${field.label} must use key=value or JSON object syntax`,
      );
    return { [key]: raw.slice(separator + 1) };
  }
  if (field.kind === 'key-value') {
    if (!raw.trim()) return {};
    const entries = raw.split(',').map((item): [string, string] => {
      const pair = item.trim();
      const separator = pair.indexOf('=');
      if (separator < 1)
        throw new Error(`${field.label} must use key=value pairs`);
      return [pair.slice(0, separator), pair.slice(separator + 1)];
    });
    return Object.fromEntries(entries);
  }
  return raw;
}

export function isConfiguredSecretMarker(
  value: unknown,
): value is { configured: boolean } {
  return (
    isRecord(value) &&
    Object.keys(value).length === 1 &&
    typeof value.configured === 'boolean'
  );
}

const SETUP_FIELD_HELP: Record<string, string> = {
  $id: 'A unique name for this connection. Keep the suggested name or enter your own.',
  authMode:
    'Choose how Klex should authenticate. The next steps change to match this choice.',
  apiKey:
    'The API credential issued by this provider. Paste the key directly or use $' +
    '{env:VARIABLE_NAME}. It is hidden on screen.',
  baseUrl:
    'The complete API base URL, including any required version path. Keep the default unless you use a proxy or compatible endpoint.',
  headers:
    'Optional HTTP headers sent with every request. Use Header=value pairs separated by commas.',
  httpReferer: 'The public URL OpenRouter should attribute requests to.',
  appName: 'The application name shown in OpenRouter request metadata.',
  testModelId:
    'A provider-native model ID used only to verify connectivity when model discovery is unavailable.',
  resourceName:
    'The Azure OpenAI resource name from the Azure portal, without the domain suffix.',
  apiVersion:
    'The Azure API version in YYYY-MM-DD or YYYY-MM-DD-preview format.',
  useDeploymentBasedUrls:
    'Enable this only when your Azure resource expects deployment-based request URLs.',
  region:
    'The cloud region that hosts the models and credentials for this connection.',
  accessKeyId: 'The AWS access-key ID used to authenticate with Bedrock.',
  secretAccessKey: 'The AWS secret access key paired with the access-key ID.',
  sessionToken:
    'The temporary AWS session token, if these are short-lived credentials.',
  project: 'The Google Cloud project ID that owns the Vertex AI resources.',
  location: 'The Google Cloud region where Vertex AI requests should run.',
  googleCredentials:
    'A Google service-account JSON object. Paste the entire downloaded credential object.',
  codexExecutable: 'The command or full path used to start the Codex CLI.',
  authFile:
    'An optional path to the Codex authentication file. Leave blank to use the CLI default.',
};

function setupFieldHelp(field: SetupField): string {
  if (field.description) return field.description;
  const specificHelp = SETUP_FIELD_HELP[field.key];
  if (specificHelp) return specificHelp;
  if (field.kind === 'select')
    return 'Choose the option that matches this provider connection.';
  if (field.kind === 'boolean')
    return 'Choose whether this provider option should be enabled.';
  if (field.kind === 'url')
    return 'Enter the complete URL, including http:// or https://.';
  if (field.kind === 'secret' || field.kind === 'secret-key-value') {
    return 'Enter the credential required by this provider. The value is hidden while you type.';
  }
  if (field.kind === 'key-value') {
    return 'Enter comma-separated key=value pairs. Values may contain additional equals signs.';
  }
  if (field.kind === 'number')
    return 'Enter a numeric value for this provider setting.';
  return `Enter the ${field.label.toLowerCase()} expected by this provider.`;
}

function setupFieldPlaceholder(field: SetupField): string {
  if (field.placeholder) return field.placeholder;
  if (field.kind === 'secret-key-value') {
    return '{"Authorization":"Bearer $' + '{env:TOKEN}"}';
  }
  if (field.kind === 'secret')
    return 'Paste value or $' + '{env:VARIABLE_NAME}';
  if (field.kind === 'key-value') return 'Header=value, Another=value';
  if (field.key === 'baseUrl') return 'https://api.example.com/v1';
  if (field.key === 'testModelId') return 'provider-native-model-id';
  if (field.key === 'project') return 'my-google-cloud-project';
  if (field.key === 'location') return 'us-central1';
  if (field.key === 'region') return 'us-east-1';
  if (field.key === 'resourceName') return 'my-azure-openai-resource';
  return '';
}

export function nextProviderInstanceId(
  providerType: string,
  existingInstanceIds: readonly string[],
): string {
  const existingIds = new Set(existingInstanceIds);
  if (!existingIds.has(providerType)) return providerType;
  let suffix = 2;
  while (existingIds.has(`${providerType}-${suffix}`)) suffix += 1;
  return `${providerType}-${suffix}`;
}

function ProviderSetupForm({
  type,
  instanceId,
  existingInstanceIds = [],
  initialSettings = {},
  onCancel,
  onSubmit,
}: {
  type: ProviderTypeInfo;
  instanceId?: string;
  existingInstanceIds?: readonly string[];
  initialSettings?: Record<string, unknown>;
  onCancel: () => void;
  onSubmit: (id: string, settings: Record<string, unknown>) => Promise<void>;
}) {
  const baseFields = useMemo<SetupField[]>(
    () => [
      ...(instanceId
        ? []
        : [
            {
              key: '$id',
              label: 'Instance ID',
              kind: 'text' as const,
              required: true,
              defaultValue: nextProviderInstanceId(
                type.type,
                existingInstanceIds,
              ),
            },
          ]),
      ...setupFieldsFromSchema(type),
    ],
    [existingInstanceIds, instanceId, type],
  );
  const defaults = useMemo(
    () =>
      Object.fromEntries(
        baseFields.flatMap((field) =>
          field.defaultValue === undefined
            ? []
            : [[field.key, field.defaultValue]],
        ),
      ),
    [baseFields],
  );
  const [index, setIndex] = useState(0);
  const [values, setValues] = useState<Record<string, unknown>>({
    ...defaults,
    ...initialSettings,
  });
  const fields = activeSetupFields(baseFields, values);
  const field = fields[Math.min(index, fields.length - 1)];
  const [value, setValue] = useState('');
  const [validationError, setValidationError] = useState<string>();
  useEffect(() => {
    if (!field) return;
    const current = values[field.key];
    const isConfiguredSecret =
      (field.kind === 'secret' || field.kind === 'secret-key-value') &&
      isConfiguredSecretMarker(current) &&
      current.configured;
    setValue(isConfiguredSecret ? '' : String(current ?? ''));
    setValidationError(undefined);
  }, [field, values]);
  useMenuInput({
    [MenuKeys.Back]: () => {
      if (index === 0) onCancel();
      else setIndex((current) => current - 1);
    },
  });
  if (!field) return null;

  const commit = (raw: string) => {
    const initialValue = initialSettings[field.key];
    const omitConfiguredSecret =
      (field.kind === 'secret' || field.kind === 'secret-key-value') &&
      !raw &&
      isConfiguredSecretMarker(initialValue) &&
      initialValue.configured;
    if (
      field.required &&
      !raw &&
      field.defaultValue === undefined &&
      !omitConfiguredSecret
    ) {
      setValidationError(`${field.label} is required`);
      return;
    }
    try {
      let next: Record<string, unknown>;
      if (omitConfiguredSecret) {
        next = values;
      } else if (!field.required && !raw) {
        const { [field.key]: _omitted, ...remainingValues } = values;
        next = remainingValues;
      } else {
        next = { ...values, [field.key]: parseSetupValue(field, raw) };
      }
      const nextFields = activeSetupFields(baseFields, next);
      if (index >= nextFields.length - 1) {
        const { $id, ...settings } = next;
        const secretKeys = new Set(
          baseFields
            .filter(
              (setupField) =>
                setupField.kind === 'secret' ||
                setupField.kind === 'secret-key-value',
            )
            .map((setupField) => setupField.key),
        );
        const cleanSettings = Object.fromEntries(
          Object.entries(settings).filter(
            ([key, setting]) =>
              !(secretKeys.has(key) && isConfiguredSecretMarker(setting)),
          ),
        );
        void onSubmit(instanceId ?? String($id), cleanSettings);
      } else {
        setValues(next);
        setIndex(index + 1);
      }
    } catch (error) {
      setValidationError(
        error instanceof Error ? error.message : 'Invalid field value',
      );
    }
  };

  const choices =
    field.kind === 'boolean'
      ? [
          { label: 'Yes', value: 'true' },
          { label: 'No', value: 'false' },
        ]
      : (field.options ?? []);
  const currentChoice = String(values[field.key] ?? field.defaultValue ?? '');
  const initialChoiceIndex = Math.max(
    0,
    choices.findIndex((choice) => choice.value === currentChoice),
  );

  return (
    <ScreenSection
      title={`Step ${index + 1} of ${fields.length} · ${field.label}`}
    >
      <Text dimColor>{type.description}</Text>
      <Box marginTop={1} flexDirection="column">
        <Text color={field.required ? 'yellow' : undefined} bold>
          {field.required ? 'Required' : 'Optional'}
        </Text>
        <Text>{setupFieldHelp(field)}</Text>
        {field.defaultValue !== undefined && (
          <Text dimColor>Default: {String(field.defaultValue)}</Text>
        )}
        {(field.kind === 'secret' || field.kind === 'secret-key-value') &&
          Boolean(initialSettings[field.key]) && (
            <Text color="yellow">
              A secret is already configured. Leave blank to keep it.
            </Text>
          )}
      </Box>
      <InsetPanel marginTop={1} tone={validationError ? 'error' : 'neutral'}>
        <Text bold>
          {field.kind === 'select' || field.kind === 'boolean'
            ? 'Choose a value'
            : 'Enter a value'}
        </Text>
        {validationError && <Text color="red">{validationError}</Text>}
        {field.kind === 'select' || field.kind === 'boolean' ? (
          <MenuList
            key={field.key}
            initialIndex={initialChoiceIndex}
            items={choices}
            bordered={false}
            onSelect={(item) => commit(item.value)}
          />
        ) : (
          <TextInput
            key={field.key}
            value={value}
            onChange={setValue}
            placeholder={setupFieldPlaceholder(field)}
            onSubmit={commit}
            mask={
              field.kind === 'secret' || field.kind === 'secret-key-value'
                ? '*'
                : undefined
            }
            showCursor
          />
        )}
      </InsetPanel>
      <Box marginTop={1} justifyContent="space-between">
        <Text dimColor>
          <KeyHint keyName="esc" />{' '}
          {index === 0 ? 'Cancel setup' : 'Previous step'}
        </Text>
        <Text dimColor>
          <KeyHint keyName="enter" />{' '}
          {index === fields.length - 1 ? 'Save provider' : 'Continue'}
        </Text>
      </Box>
    </ScreenSection>
  );
}

function fuzzyModelMatch(model: KnownModel, query: string): boolean {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const fields = [model.displayName ?? '', model.modelId].map((field) =>
    field.toLowerCase(),
  );
  return terms.every((term) =>
    fields.some((field) => {
      let index = 0;
      for (const character of field) {
        if (character === term[index]) index += 1;
      }
      return index === term.length;
    }),
  );
}

function KnownModelsPage({
  provider,
  apiClient,
  onActionStateChange,
  onEditModel,
}: {
  provider: ProviderInfo;
  apiClient: AdminApiClient;
  onActionStateChange: (state: {
    filterFocused: boolean;
    modelHighlighted: boolean;
    manualModelHighlighted: boolean;
  }) => void;
  onEditModel: (model: KnownModel) => void;
}) {
  const { pushToast } = useToast();
  const { setActive } = useTextInputActive();
  const [query, setQuery] = useState('');
  const [filterFocused, setFilterFocused] = useState(false);
  const [highlightedModelId, setHighlightedModelId] = useState<string>();
  const modelsPoll = usePolling(
    () => apiClient.getKnownModels(provider.id),
    15000,
  );
  const models = (modelsPoll.data?.models ?? []).filter((model) =>
    fuzzyModelMatch(model, query),
  );
  const highlightedIndex = Math.max(
    0,
    models.findIndex((model) => model.modelId === highlightedModelId),
  );
  const highlighted = models[highlightedIndex];

  useEffect(() => {
    setActive(filterFocused);
    return () => setActive(false);
  }, [filterFocused, setActive]);
  useEffect(
    () =>
      onActionStateChange({
        filterFocused,
        modelHighlighted: highlighted !== undefined,
        manualModelHighlighted:
          highlighted !== undefined && highlighted.source !== 'discovered',
      }),
    [filterFocused, highlighted, onActionStateChange],
  );

  useMenuInput({
    '/': () => setFilterFocused(true),
    [MenuKeys.Refresh]: () => {
      if (!provider.metadata.capabilities.modelDiscovery) return;
      void apiClient
        .getKnownModels(provider.id, true)
        .then(() => {
          modelsPoll.refresh();
          pushToast('Discovered models refreshed', 'info');
        })
        .catch((error) =>
          pushProviderError(pushToast, error, 'Failed to refresh models'),
        );
    },
    [MenuKeys.Delete]: () => {
      if (!highlighted || highlighted.source === 'discovered') return;
      void apiClient
        .deleteKnownModel(provider.id, highlighted.modelId)
        .then(() => {
          setHighlightedModelId(undefined);
          modelsPoll.refresh();
          pushToast('Known model deleted', 'info');
        })
        .catch((error) =>
          pushProviderError(pushToast, error, 'Failed to delete model'),
        );
    },
  });

  return (
    <ScreenSection title="Known models">
      <Text dimColor>
        Discovered and manually added models for {provider.metadata.displayName}
        .
      </Text>
      <Box marginTop={1}>
        <Text>Search: </Text>
        <TextInput
          value={query}
          focus={filterFocused}
          onChange={(value) => {
            setQuery(value);
            setHighlightedModelId(undefined);
          }}
          onSubmit={() => {
            setFilterFocused(false);
            setActive(false);
          }}
          placeholder="press / to search by name or model ID"
        />
      </Box>
      {modelsPoll.loading ? (
        <ActivityIndicator label="Loading models..." />
      ) : models.length === 0 ? (
        <Text dimColor>No matching known models.</Text>
      ) : (
        <MenuList
          key={query}
          items={models.map((model) => ({
            label: `${model.displayName ?? model.modelId} — ${model.modelId} (${model.source})`,
            value: model.modelId,
          }))}
          selectedIndex={highlightedIndex}
          isFocused={!filterFocused}
          visibleCount={10}
          onHighlight={(item) => setHighlightedModelId(item.value)}
          onSelect={(item) => {
            const model = models.find(
              (candidate) => candidate.modelId === item.value,
            );
            if (model) onEditModel(model);
          }}
        />
      )}
    </ScreenSection>
  );
}

function ProviderDetail({
  provider,
  apiClient,
  onDeleted,
  onEdit,
  onManageModels,
}: {
  provider: ProviderInfo;
  apiClient: AdminApiClient;
  onDeleted: () => void;
  onEdit: () => void;
  onManageModels: () => void;
}) {
  const { pushToast } = useToast();
  const [connectionStatus, setConnectionStatus] = useState<string>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const items = [
    { label: 'Edit settings', value: 'edit' },
    ...(provider.metadata.capabilities.connectivityTest
      ? [{ label: 'Test connectivity', value: 'test' }]
      : []),
    { label: 'Manage known models', value: 'models' },
    { label: 'Delete provider instance', value: 'delete' },
  ];
  if (confirmDelete) {
    return (
      <ConfirmationPanel
        title={`Delete ${provider.metadata.displayName}?`}
        onConfirm={async () => {
          try {
            await apiClient.deleteProvider(provider.id);
            onDeleted();
            pushToast('Provider deleted', 'info');
          } catch (error) {
            pushProviderError(pushToast, error, 'Provider deletion failed');
            setConfirmDelete(false);
          }
        }}
        onCancel={() => setConfirmDelete(false)}
      >
        This permanently removes the provider configuration.
      </ConfirmationPanel>
    );
  }
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{provider.metadata.displayName}</Text>
      <DetailList labelWidth={10}>
        <DetailRow label="Type">{provider.type}</DetailRow>
        <DetailRow label="Description">
          {provider.metadata.description}
        </DetailRow>
      </DetailList>
      {connectionStatus && <Text>{connectionStatus}</Text>}

      <Box marginTop={1}>
        <MenuList
          items={items}
          onSelect={async (item) => {
            try {
              if (item.value === 'edit') onEdit();
              else if (item.value === 'test') {
                setConnectionStatus('Testing connectivity...');
                const result = await apiClient.testProvider(provider.id);
                setConnectionStatus(
                  `Connected in ${result.latencyMs}ms${result.target ? ` — ${result.target}` : ''}`,
                );
                pushToast('Connection succeeded', 'info');
              } else if (item.value === 'models') onManageModels();
              else if (item.value === 'delete') {
                if (!provider.operations.remove.available) {
                  pushToast(
                    [
                      provider.operations.remove.message,
                      provider.operations.remove.remediation,
                    ]
                      .filter(Boolean)
                      .join(' — '),
                    'error',
                  );
                } else setConfirmDelete(true);
              }
            } catch (error) {
              setConnectionStatus(undefined);
              pushProviderError(pushToast, error, 'Provider action failed');
            }
          }}
        />
      </Box>
    </Box>
  );
}

function pushProviderError(
  pushToast: ReturnType<typeof useToast>['pushToast'],
  error: unknown,
  fallback: string,
): void {
  if (!(error instanceof AdminApiClientError)) {
    pushToast(error instanceof Error ? error.message : fallback, 'error');
    return;
  }
  const details = [
    error.code ? `[${error.code}]` : undefined,
    error.message,
    error.remediation,
  ].filter(Boolean);
  pushToast(details.join(' — '), 'error');
}

type KnownModelDefinition = Pick<
  KnownModel,
  'capabilities' | 'contextSize' | 'displayName' | 'kind'
>;

const MODEL_KINDS: readonly NonNullable<KnownModel['kind']>[] = [
  'language',
  'speech-to-speech',
  'text-to-speech',
  'speech-to-text',
  'image-generation',
  'embedding',
  'reranking',
  'moderation',
  'unknown',
];

function KnownModelForm({
  model,
  lockModelId = false,
  onCancel,
  onSubmit,
}: {
  model?: KnownModel;
  lockModelId?: boolean;
  onCancel: () => void;
  onSubmit: (
    modelId: string,
    definition: KnownModelDefinition,
  ) => Promise<void>;
}) {
  const fields = [
    ...(!lockModelId
      ? [
          {
            key: 'modelId' as const,
            label: 'Model ID',
            placeholder: 'provider-native/model:id',
          },
        ]
      : []),
    {
      key: 'displayName' as const,
      label: 'Display name',
      placeholder: model?.modelId ?? 'Optional display name',
    },
    {
      key: 'kind' as const,
      label: 'Model kind',
      placeholder: 'language',
    },
    {
      key: 'contextSize' as const,
      label: 'Context size',
      placeholder: 'e.g. 128000',
    },
    {
      key: 'capabilities' as const,
      label: 'Capabilities JSON',
      placeholder: '{"input":{"image":{}},"tools":true}',
    },
  ];
  const initialValues: Record<(typeof fields)[number]['key'], string> = {
    modelId: model?.modelId ?? '',
    displayName: model?.displayName ?? '',
    kind: model?.kind ?? '',
    contextSize: model?.contextSize ? String(model.contextSize) : '',
    capabilities: model?.capabilities ? JSON.stringify(model.capabilities) : '',
  };
  const [index, setIndex] = useState(0);
  const [values, setValues] = useState(initialValues);
  const [value, setValue] = useState('');
  const [validationError, setValidationError] = useState<string>();
  const field = fields[index];

  useEffect(() => {
    if (!field) return;
    setValue(values[field.key]);
    setValidationError(undefined);
  }, [field, values]);
  useMenuInput({
    [MenuKeys.Back]: () => {
      if (index === 0) onCancel();
      else setIndex((current) => current - 1);
    },
  });
  if (!field) return null;

  const commit = (raw: string) => {
    const trimmed = raw.trim();
    try {
      if (field.key === 'modelId' && !trimmed)
        throw new Error('Model ID is required');
      if (
        field.key === 'kind' &&
        trimmed &&
        !MODEL_KINDS.includes(trimmed as never)
      )
        throw new Error(`Model kind must be one of: ${MODEL_KINDS.join(', ')}`);
      if (
        field.key === 'contextSize' &&
        trimmed &&
        (!Number.isInteger(Number(trimmed)) || Number(trimmed) <= 0)
      )
        throw new Error('Context size must be a positive integer');
      if (field.key === 'capabilities' && trimmed) {
        const capabilities = JSON.parse(trimmed);
        if (
          typeof capabilities !== 'object' ||
          capabilities === null ||
          Array.isArray(capabilities)
        )
          throw new Error('Capabilities must be a JSON object');
      }
      const next = { ...values, [field.key]: trimmed };
      if (index < fields.length - 1) {
        setValues(next);
        setIndex(index + 1);
        return;
      }
      const modelId = lockModelId ? model?.modelId : next.modelId;
      if (!modelId) throw new Error('Model ID is required');
      const definition: KnownModelDefinition = {
        ...(next.displayName && { displayName: next.displayName }),
        ...(next.kind && { kind: next.kind as KnownModel['kind'] }),
        ...(next.contextSize && { contextSize: Number(next.contextSize) }),
        ...(next.capabilities && {
          capabilities: JSON.parse(next.capabilities),
        }),
      };
      if (Object.keys(definition).length === 0)
        throw new Error('Provide at least one model metadata field');
      void onSubmit(modelId, definition);
    } catch (error) {
      setValidationError(
        error instanceof Error ? error.message : 'Invalid model metadata',
      );
    }
  };

  return (
    <ScreenSection
      title={lockModelId ? `Override ${model?.modelId}` : 'Known model'}
    >
      <Text dimColor>
        Values entered here override discovered and maintained metadata for the
        same model ID.
      </Text>
      <Box marginTop={1}>
        <Text>{field.label}: </Text>
        <TextInput
          value={value}
          onChange={setValue}
          placeholder={field.placeholder}
          onSubmit={commit}
          showCursor
        />
      </Box>
      {validationError ? <Text color="red">{validationError}</Text> : null}
      <Text dimColor>
        Step {index + 1}/{fields.length} · Enter next · Esc back
      </Text>
    </ScreenSection>
  );
}
