import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import { useEffect, useMemo, useState } from 'react';

import {
  type AdminApiClient,
  AdminApiClientError,
  type ProviderInfo,
  type ProviderResponse,
  type ProviderTypeInfo,
  type ProviderTypesResponse,
} from '../api-client';
import { usePolling } from '../hooks/use-polling';
import { useScreenMeta } from '../hooks/use-screen-meta';
import { useTextInputActive } from '../hooks/use-text-input-active';
import { useToast } from '../hooks/use-toast';
import { MenuKeys, useMenuInput } from '../menu-keys';

export interface ProvidersScreenProps {
  apiClient: AdminApiClient;
  onBack: () => void;
}

type Mode =
  | 'list'
  | 'choose-type'
  | 'configure'
  | 'detail'
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
  const [selectedModelId, setSelectedModelId] = useState<string>();
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
                : mode === 'add-model'
                  ? 'Add Known Model'
                  : mode === 'edit-model'
                    ? 'Edit Known Model'
                    : (selected?.metadata.displayName ?? 'Provider'),
      breadcrumb: ['Home', 'Settings'],
      keys:
        mode === 'list'
          ? [
              { key: 'a', label: 'Add' },
              { key: 'esc', label: 'Back' },
            ]
          : [{ key: 'esc', label: 'Back' }],
    });
  }, [mode, providerType, selected, setMeta]);
  useEffect(() => {
    const error = providersPoll.error ?? typesPoll.error;
    if (error) pushToast(`Failed to load providers: ${error.message}`, 'error');
  }, [providersPoll.error, pushToast, typesPoll.error]);

  useMenuInput({
    [MenuKeys.Back]: () => {
      if (mode === 'list') onBack();
      else setMode('list');
    },
    [MenuKeys.Add]: () => {
      if (mode === 'list') setMode('choose-type');
    },
  });

  if (mode === 'choose-type') {
    return (
      <SelectInput
        items={(typesPoll.data?.providerTypes ?? []).map((type) => ({
          label: `${type.displayName} — ${type.description}`,
          value: type.type,
        }))}
        onSelect={(item) => {
          setProviderType(
            typesPoll.data?.providerTypes.find(
              (type) => type.type === item.value,
            ),
          );
          setMode('configure');
        }}
      />
    );
  }

  if (mode === 'configure' && providerType) {
    return (
      <ProviderSetupForm
        type={providerType}
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

  if (mode === 'edit-model' && selected && selectedModelId) {
    return (
      <SingleValueForm
        label="Display name"
        placeholder={selectedModelId}
        onCancel={() => setMode('detail')}
        onSubmit={async (displayName) => {
          try {
            await apiClient.updateKnownModel(selected.id, selectedModelId, {
              displayName,
            });
            setMode('detail');
            pushToast('Known model updated', 'info');
          } catch (error) {
            pushProviderError(pushToast, error, 'Failed to update model');
          }
        }}
      />
    );
  }

  if (mode === 'add-model' && selected) {
    return (
      <SingleValueForm
        label="Model ID"
        placeholder="provider-native/model:id"
        onCancel={() => setMode('detail')}
        onSubmit={async (modelId) => {
          try {
            await apiClient.createKnownModel(selected.id, {
              modelId,
              displayName: modelId,
            });
            setMode('detail');
            pushToast('Known model added', 'info');
          } catch (error) {
            pushToast(
              error instanceof Error ? error.message : 'Failed to add model',
              'error',
            );
          }
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
        onAddModel={() => setMode('add-model')}
        onEdit={() => setMode('edit')}
        onEditModel={(modelId) => {
          setSelectedModelId(modelId);
          setMode('edit-model');
        }}
      />
    );
  }

  const providers = providersPoll.data?.providers ?? [];
  return (
    <Box flexDirection="column" marginTop={1}>
      {providersPoll.loading && <Text dimColor>Loading...</Text>}
      {!providersPoll.loading && providers.length === 0 && (
        <Text dimColor>No providers configured. Press a to add one.</Text>
      )}
      <SelectInput
        items={providers.map((provider) => ({
          label: `${provider.metadata.displayName} (${provider.id})`,
          value: provider.id,
        }))}
        onSelect={(item) => {
          setSelected(providers.find((provider) => provider.id === item.value));
          setMode('detail');
        }}
      />
    </Box>
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

function ProviderSetupForm({
  type,
  instanceId,
  initialSettings = {},
  onCancel,
  onSubmit,
}: {
  type: ProviderTypeInfo;
  instanceId?: string;
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
              placeholder: `${type.type}-default`,
            },
          ]),
      ...setupFieldsFromSchema(type),
    ],
    [instanceId, type],
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
      const next = omitConfiguredSecret
        ? values
        : { ...values, [field.key]: parseSetupValue(field, raw) };
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

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        {field.label}
        {field.required ? ' *' : ' (optional)'}
        {field.description ? ` — ${field.description}` : ''}
      </Text>
      {(field.kind === 'secret' || field.kind === 'secret-key-value') &&
        Boolean(initialSettings[field.key]) && (
          <Text dimColor>Leave blank to keep the configured secret.</Text>
        )}
      {validationError && <Text color="red">{validationError}</Text>}
      {field.kind === 'select' || field.kind === 'boolean' ? (
        <SelectInput
          items={
            field.kind === 'boolean'
              ? [
                  { label: 'Yes', value: 'true' },
                  { label: 'No', value: 'false' },
                ]
              : (field.options ?? [])
          }
          onSelect={(item) => commit(item.value)}
        />
      ) : (
        <TextInput
          value={value}
          onChange={setValue}
          placeholder={
            field.kind === 'secret-key-value'
              ? '{"Authorization":"Bearer $' + '{env:TOKEN}"}'
              : field.kind === 'key-value'
                ? 'Header=value, Another=value'
                : (field.placeholder ?? '')
          }
          onSubmit={commit}
          mask={
            field.kind === 'secret' || field.kind === 'secret-key-value'
              ? '*'
              : undefined
          }
          showCursor
        />
      )}
      <Text dimColor>
        Step {index + 1} of {fields.length}
      </Text>
    </Box>
  );
}

function ProviderDetail({
  provider,
  apiClient,
  onDeleted,
  onAddModel,
  onEdit,
  onEditModel,
}: {
  provider: ProviderInfo;
  apiClient: AdminApiClient;
  onDeleted: () => void;
  onAddModel: () => void;
  onEdit: () => void;
  onEditModel: (modelId: string) => void;
}) {
  const { pushToast } = useToast();
  const [connectionStatus, setConnectionStatus] = useState<string>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const modelsPoll = usePolling(
    () => apiClient.getKnownModels(provider.id),
    15000,
  );
  const items = [
    { label: 'Edit settings', value: 'edit' },
    ...(provider.metadata.capabilities.connectivityTest
      ? [{ label: 'Test connectivity', value: 'test' }]
      : []),
    ...(provider.metadata.capabilities.modelDiscovery
      ? [{ label: 'Refresh discovered models', value: 'refresh' }]
      : []),
    ...(provider.metadata.capabilities.customModels
      ? [{ label: 'Add known model', value: 'add-model' }]
      : []),
    ...(modelsPoll.data?.models ?? []).flatMap((model) =>
      model.source === 'discovered'
        ? []
        : [
            {
              label: `Edit known model: ${model.modelId}`,
              value: `edit-model:${model.modelId}`,
            },
            {
              label: `Delete known model: ${model.modelId}`,
              value: `delete-model:${model.modelId}`,
            },
          ],
    ),
    ...(provider.operations.remove.available
      ? [{ label: 'Delete provider', value: 'delete' }]
      : []),
  ];
  if (confirmDelete) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text bold>Delete {provider.metadata.displayName}?</Text>
        <Text color="yellow">This removes the provider configuration.</Text>
        <SelectInput
          items={[
            { label: 'Cancel', value: 'cancel' },
            { label: 'Delete provider', value: 'confirm' },
          ]}
          onSelect={async (item) => {
            if (item.value === 'cancel') {
              setConfirmDelete(false);
              return;
            }
            try {
              await apiClient.deleteProvider(provider.id);
              onDeleted();
              pushToast('Provider deleted', 'info');
            } catch (error) {
              pushProviderError(pushToast, error, 'Provider deletion failed');
              setConfirmDelete(false);
            }
          }}
        />
      </Box>
    );
  }
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{provider.metadata.displayName}</Text>
      <Text dimColor>Type: {provider.type}</Text>
      <Text dimColor>{provider.metadata.description}</Text>
      {connectionStatus && <Text>{connectionStatus}</Text>}
      {!provider.operations.remove.available && (
        <Text color="yellow">
          Removal blocked: {provider.operations.remove.message}
          {provider.operations.remove.remediation
            ? ` — ${provider.operations.remove.remediation}`
            : ''}
        </Text>
      )}
      <Box marginTop={1} flexDirection="column">
        <Text>Models:</Text>
        {(modelsPoll.data?.models ?? []).map((model) => (
          <Text key={model.modelId}>
            {' '}
            {model.modelId} ({model.source})
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <SelectInput
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
              } else if (item.value === 'refresh') {
                await apiClient.getKnownModels(provider.id, true);
                modelsPoll.refresh();
                pushToast('Discovered models refreshed', 'info');
              } else if (item.value === 'add-model') onAddModel();
              else if (item.value.startsWith('edit-model:')) {
                onEditModel(item.value.slice('edit-model:'.length));
              } else if (item.value.startsWith('delete-model:')) {
                await apiClient.deleteKnownModel(
                  provider.id,
                  item.value.slice('delete-model:'.length),
                );
                modelsPoll.refresh();
                pushToast('Known model deleted', 'info');
              } else if (item.value === 'delete') {
                setConfirmDelete(true);
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

function SingleValueForm({
  label,
  placeholder,
  onCancel,
  onSubmit,
}: {
  label: string;
  placeholder: string;
  onCancel: () => void;
  onSubmit: (value: string) => Promise<void>;
}) {
  const [value, setValue] = useState('');
  useMenuInput({ [MenuKeys.Back]: onCancel });
  return (
    <Box marginTop={1}>
      <Text>{label}: </Text>
      <TextInput
        value={value}
        onChange={setValue}
        placeholder={placeholder}
        onSubmit={() => value.trim() && void onSubmit(value.trim())}
        showCursor
      />
    </Box>
  );
}
