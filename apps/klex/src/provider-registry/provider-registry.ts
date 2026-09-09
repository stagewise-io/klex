import { createHash, randomBytes } from 'node:crypto';

import type { LanguageModelV4 } from '@ai-sdk/provider';

import type { ModuleLogger, RootLogger } from '@stagewise/logger';

import {
  type Config,
  getProviderSettingsJsonSchema,
  isProviderSecretSetting,
  type ModelCapabilities,
  type ModelDefinition,
  type ModelInfo,
  type ModelKind,
  type ModelSelection,
  type ModelSelectionEntry,
  type ProviderType,
  parseProviderSettings,
  type ResolvedModelConfig,
  type ResolvedRealtimeProvider,
} from '@/config';

import { mergeProviderModels } from './model-metadata';

export type { ProviderType } from '@/config';
export type ProviderInstanceId = string;
export type ProviderSettings = Record<string, unknown>;
export type ProviderSettingsPatch = Record<string, unknown | null>;

export type ProviderErrorCode =
  | 'available'
  | 'dependency_missing'
  | 'authentication_required'
  | 'invalid_configuration'
  | 'not_found'
  | 'unsupported_platform'
  | 'connectivity_failed'
  | 'discovery_failed'
  | 'conflict'
  | 'referential_integrity'
  | 'internal_error';

export interface ProviderOperationFailure {
  ok: false;
  code: Exclude<ProviderErrorCode, 'available'>;
  message: string;
  remediation?: string;
}

export interface ProviderOperationSuccess<T = undefined> {
  ok: true;
  code: 'available';
  value: T;
}

export type ProviderOperationResult<T = undefined> =
  | ProviderOperationSuccess<T>
  | ProviderOperationFailure;

export interface ProviderCapabilities {
  modelDiscovery: boolean;
  connectivityTest: boolean;
  customModels: boolean;
}

export interface ProviderMetadata {
  displayName: string;
  description: string;
  logoSvg?: string;
  documentationUrl?: string;
  capabilities: ProviderCapabilities;
}

export type ModelMetadataSource =
  | 'discovered'
  | 'shared-catalog'
  | 'provider-family'
  | 'provider-exact'
  | 'user';

export interface ModelMetadataProvenance {
  source: ModelMetadataSource;
  documentationUrl?: string;
  reviewedAt?: string;
}

export interface ProviderModel {
  modelId: string;
  kind?: ModelKind;
  displayName?: string;
  contextSize?: number;
  capabilities?: ModelCapabilities;
  provenance?: ModelMetadataProvenance[];
}

export interface ProviderInstance {
  id: ProviderInstanceId;
  type: ProviderType;
  settings: ProviderSettings;
  knownModels?: Record<string, Omit<ProviderModel, 'modelId'>>;
}

export interface ProviderConnectionResult {
  latencyMs: number;
  target?: string;
}

export interface ProviderDefinition {
  type: ProviderType;
  /** Developer guidance: intended service/protocol, authentication, adjacent types, and when to use an alternative. */
  usageGuidance: string;
  metadata: Omit<ProviderMetadata, 'capabilities'>;
  preflightCreate?(
    settings: ProviderSettings,
    signal: AbortSignal,
  ): Promise<ProviderOperationResult>;
  createLanguageModel(
    instance: ProviderInstance,
    modelId: string,
  ): LanguageModelV4;
  discoverModels?(
    instance: ProviderInstance,
    signal: AbortSignal,
  ): Promise<ProviderOperationResult<readonly ProviderModel[]>>;
  resolveModelMetadata?(
    modelId: string,
  ): Omit<ProviderModel, 'modelId'> | undefined;
  testConnection(
    instance: ProviderInstance,
    signal: AbortSignal,
  ): Promise<ProviderOperationResult<ProviderConnectionResult>>;
}

export interface ProviderTypeInfo extends ProviderMetadata {
  type: ProviderType;
  settingsSchema: Record<string, unknown>;
}

export interface ResolvedProviderModel extends ProviderModel {
  source: 'discovered' | 'manual' | 'merged';
}

export interface ModelSelectionWarning {
  modelId: string;
  message: string;
}

export interface ModelSelectionUpdate {
  selection: ModelSelection;
  warnings: readonly ModelSelectionWarning[];
}

export interface ProviderInstanceInfo {
  id: ProviderInstanceId;
  type: ProviderType;
  settings: SerializedProviderSettings;
  metadata: ProviderMetadata;
  operations: {
    update: { available: true };
    remove:
      | { available: true }
      | {
          available: false;
          code: 'referential_integrity';
          message: string;
          remediation: string;
        };
  };
}

export type SerializedProviderSettings = Record<
  string,
  unknown | { configured: boolean }
>;

export interface ProviderModelResolver {
  getLanguageModel(reference: ModelSelectionEntry): LanguageModelV4;
  resolveModel(reference: ModelSelectionEntry): ResolvedModelConfig;
  resolveModelInfo(reference: ModelSelectionEntry): ModelInfo;
}

export interface ProviderRegistry extends ProviderModelResolver {
  start(): Promise<void>;
  close(): Promise<void>;
  listProviderTypes(): readonly ProviderTypeInfo[];
  serializeSettings(
    type: ProviderType,
    settings: ProviderSettings,
  ): SerializedProviderSettings;
  listInstances(): readonly ProviderInstanceInfo[];
  resolveRealtimeProvider(): ResolvedRealtimeProvider | undefined;
  preflightCreate(
    type: ProviderType,
    settings: unknown,
  ): Promise<ProviderOperationResult<ProviderSettings>>;
  addInstance(
    instance: ProviderInstance,
  ): Promise<ProviderOperationResult<ProviderInstanceInfo>>;
  updateInstance(
    id: ProviderInstanceId,
    patch: { settings?: ProviderSettingsPatch },
  ): Promise<ProviderOperationResult<ProviderInstanceInfo>>;
  removeInstance(id: ProviderInstanceId): Promise<ProviderOperationResult>;
  addKnownModel(
    id: ProviderInstanceId,
    modelId: string,
    definition: ModelDefinition,
  ): Promise<ProviderOperationResult>;
  updateKnownModel(
    id: ProviderInstanceId,
    modelId: string,
    patch: Partial<ModelDefinition>,
  ): Promise<ProviderOperationResult>;
  removeKnownModel(
    id: ProviderInstanceId,
    modelId: string,
  ): Promise<ProviderOperationResult>;
  updateModelSelection(
    patch: Partial<ModelSelection>,
  ): Promise<ProviderOperationResult<ModelSelectionUpdate>>;
  listModels(
    id: ProviderInstanceId,
    refresh?: boolean,
  ): Promise<ProviderOperationResult<readonly ResolvedProviderModel[]>>;
  testConnection(
    id: ProviderInstanceId,
  ): Promise<ProviderOperationResult<ProviderConnectionResult>>;
}

export interface ProviderRegistryDependencies {
  logging: RootLogger;
  definitions: readonly ProviderDefinition[];
  config?: Config;
}

class ProviderRegistryModule implements ProviderRegistry {
  private readonly definitions: ReadonlyMap<ProviderType, ProviderDefinition>;
  private started = false;
  private unsubscribe: (() => void) | undefined;
  private readonly modelCache = new Map<
    ProviderInstanceId,
    { signature: string; models: readonly ProviderModel[] }
  >();
  private readonly pendingDiscovery = new Map<
    ProviderInstanceId,
    Promise<ProviderOperationResult<readonly ProviderModel[]>>
  >();
  private mutationQueue: Promise<void> = Promise.resolve();
  private configGeneration = 0;
  private readonly signatureSalt = randomBytes(32);

  constructor(
    private readonly deps: {
      logger: ModuleLogger;
      definitions: readonly ProviderDefinition[];
      config?: Config;
    },
  ) {
    this.definitions = validateDefinitions(deps.definitions);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.unsubscribe = this.deps.config?.subscribe(() => {
      this.configGeneration += 1;
      this.modelCache.clear();
      this.pendingDiscovery.clear();
    });
    this.started = true;
    this.deps.logger.info(
      { providerTypeCount: this.definitions.size },
      'Provider registry started',
    );
  }

  async close(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.configGeneration += 1;
    this.modelCache.clear();
    this.pendingDiscovery.clear();
    this.deps.logger.info('Provider registry stopped');
  }

  listProviderTypes(): readonly ProviderTypeInfo[] {
    return [...this.definitions.values()]
      .map((definition) => ({
        type: definition.type,
        ...providerMetadata(definition),
        settingsSchema: getProviderSettingsJsonSchema(definition.type),
      }))
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
  }

  serializeSettings(
    type: ProviderType,
    settings: ProviderSettings,
  ): SerializedProviderSettings {
    if (!this.definitions.has(type))
      throw new Error(`Unknown provider type '${type}'`);
    const validated = parseProviderSettings(type, settings);
    return Object.fromEntries(
      Object.entries(validated).map(([key, value]) => [
        key,
        isProviderSecretSetting(type, key)
          ? {
              configured:
                (typeof value === 'string' && value.length > 0) ||
                (isRecord(value) && Object.keys(value).length > 0),
            }
          : structuredClone(value),
      ]),
    );
  }

  listInstances(): readonly ProviderInstanceInfo[] {
    const config = this.requireConfig();
    return Object.entries(config.get().providers)
      .map(([id, instance]) => this.instanceInfo({ id, ...instance }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async preflightCreate(
    type: ProviderType,
    input: unknown,
  ): Promise<ProviderOperationResult<ProviderSettings>> {
    this.assertStarted();
    const definition = this.definitions.get(type);
    if (!definition)
      return failure(
        'invalid_configuration',
        `Unknown provider type '${type}'`,
      );
    const validated = validateSettings(type, input);
    if (!validated.ok) return validated;
    const preflight = definition.preflightCreate;
    const checked = preflight
      ? await this.runHook((signal) => preflight(validated.value, signal))
      : success(undefined);
    return checked.ok ? success(validated.value) : checked;
  }

  addInstance(
    instance: ProviderInstance,
  ): Promise<ProviderOperationResult<ProviderInstanceInfo>> {
    return this.mutateExclusive(() => this.addInstanceNow(instance));
  }

  private async addInstanceNow(
    instance: ProviderInstance,
  ): Promise<ProviderOperationResult<ProviderInstanceInfo>> {
    const config = this.requireConfig();
    if (config.get().providers[instance.id])
      return failure('conflict', `Provider '${instance.id}' already exists`);
    const definition = this.definitions.get(instance.type);
    if (!definition)
      return failure(
        'invalid_configuration',
        `Unknown provider type '${instance.type}'`,
      );
    const preflight = await this.preflightCreate(
      instance.type,
      instance.settings,
    );
    if (!preflight.ok) return preflight;
    const stored: ProviderInstance = { ...instance, settings: preflight.value };
    try {
      await config.writeProviderInstance(stored.id, withoutId(stored));
    } catch (error) {
      return failure('internal_error', sanitizedError(error));
    }
    return success(this.instanceInfo(stored));
  }

  updateInstance(
    id: ProviderInstanceId,
    patch: { settings?: ProviderSettingsPatch },
  ): Promise<ProviderOperationResult<ProviderInstanceInfo>> {
    return this.mutateExclusive(() => this.updateInstanceNow(id, patch));
  }

  private async updateInstanceNow(
    id: ProviderInstanceId,
    patch: { settings?: ProviderSettingsPatch },
  ): Promise<ProviderOperationResult<ProviderInstanceInfo>> {
    const config = this.requireConfig();
    const currentConfig = config.get().providers[id];
    if (!currentConfig) return failure('not_found', `Unknown provider '${id}'`);
    const current: ProviderInstance = { id, ...currentConfig };
    const definition = this.definitions.get(current.type);
    if (!definition)
      return failure(
        'invalid_configuration',
        `Unknown provider type '${current.type}'`,
      );
    const settings = applySettingsPatch(current.settings, patch.settings);
    const validated = validateSettings(current.type, settings);
    if (!validated.ok) return validated;
    const preflight = definition.preflightCreate;
    const checked = preflight
      ? await this.runHook((signal) => preflight(validated.value, signal))
      : success(undefined);
    if (!checked.ok) return checked;
    const updated: ProviderInstance = {
      ...current,
      settings: validated.value,
    };
    try {
      await config.writeProviderInstance(id, withoutId(updated));
    } catch (error) {
      return failure('internal_error', sanitizedError(error));
    }
    return success(this.instanceInfo(updated));
  }

  removeInstance(id: ProviderInstanceId): Promise<ProviderOperationResult> {
    return this.mutateExclusive(() => this.removeInstanceNow(id));
  }

  private async removeInstanceNow(
    id: ProviderInstanceId,
  ): Promise<ProviderOperationResult> {
    const config = this.requireConfig();
    const currentConfig = config.get().providers[id];
    if (!currentConfig) return failure('not_found', `Unknown provider '${id}'`);
    if (isProviderReferenced(config.get().modelSelection, id)) {
      return failure(
        'referential_integrity',
        `Provider '${id}' is referenced by model selection`,
        'Remove this provider from every model-selection purpose first.',
      );
    }
    const instance: ProviderInstance = { id, ...currentConfig };
    const definition = this.definitions.get(instance.type);
    if (!definition)
      return failure(
        'invalid_configuration',
        `Unknown provider type '${instance.type}'`,
      );
    try {
      await config.deleteProviderInstance(id);
    } catch (error) {
      return failure('internal_error', sanitizedError(error));
    }
    return success(undefined);
  }

  addKnownModel(
    id: ProviderInstanceId,
    modelId: string,
    definition: ModelDefinition,
  ): Promise<ProviderOperationResult> {
    return this.mutateExclusive(() =>
      this.writeKnownModel(id, modelId, definition, 'create'),
    );
  }

  updateKnownModel(
    id: ProviderInstanceId,
    modelId: string,
    patch: Partial<ModelDefinition>,
  ): Promise<ProviderOperationResult> {
    return this.mutateExclusive(() =>
      this.updateKnownModelNow(id, modelId, patch),
    );
  }

  private async updateKnownModelNow(
    id: ProviderInstanceId,
    modelId: string,
    patch: Partial<ModelDefinition>,
  ): Promise<ProviderOperationResult> {
    const current =
      this.requireConfig().get().providers[id]?.knownModels?.[modelId];
    if (!current)
      return failure(
        'invalid_configuration',
        `Unknown known model '${modelId}'`,
      );
    return this.writeKnownModel(
      id,
      modelId,
      { ...current, ...patch },
      'update',
    );
  }

  removeKnownModel(
    id: ProviderInstanceId,
    modelId: string,
  ): Promise<ProviderOperationResult> {
    return this.mutateExclusive(() => this.removeKnownModelNow(id, modelId));
  }

  private async removeKnownModelNow(
    id: ProviderInstanceId,
    modelId: string,
  ): Promise<ProviderOperationResult> {
    const config = this.requireConfig();
    const provider = config.get().providers[id];
    if (!provider) return failure('not_found', `Unknown provider '${id}'`);
    if (!provider.knownModels?.[modelId])
      return failure(
        'invalid_configuration',
        `Unknown known model '${modelId}'`,
      );
    const knownModels = { ...provider.knownModels };
    delete knownModels[modelId];
    try {
      await config.writeProviderInstance(id, {
        ...provider,
        knownModels:
          Object.keys(knownModels).length > 0 ? knownModels : undefined,
      });
      this.modelCache.delete(id);
      return success(undefined);
    } catch (error) {
      return failure('internal_error', sanitizedError(error));
    }
  }

  updateModelSelection(
    patch: Partial<ModelSelection>,
  ): Promise<ProviderOperationResult<ModelSelectionUpdate>> {
    return this.mutateExclusive(() => this.updateModelSelectionNow(patch));
  }

  private async updateModelSelectionNow(
    patch: Partial<ModelSelection>,
  ): Promise<ProviderOperationResult<ModelSelectionUpdate>> {
    const config = this.requireConfig();
    const current = config.get();
    const merged: ModelSelection = {
      chat: patch.chat ?? current.modelSelection.chat,
      compaction: patch.compaction ?? current.modelSelection.compaction,
      memory: patch.memory ?? current.modelSelection.memory,
      imageVision: patch.imageVision ?? current.modelSelection.imageVision,
      audioListening:
        patch.audioListening ?? current.modelSelection.audioListening,
      voice: patch.voice ?? current.modelSelection.voice,
    };
    const changed: ModelSelection = {
      chat: patch.chat ?? [],
      compaction: patch.compaction ?? [],
      memory: patch.memory ?? [],
      imageVision: patch.imageVision ?? [],
      audioListening: patch.audioListening ?? [],
      voice: patch.voice ?? { sts: [], tts: [], stt: [] },
    };
    const warnings: ModelSelectionWarning[] = [];
    for (const [purpose, entries] of modelSelectionEntries(changed)) {
      const previousEntries =
        modelSelectionEntries(current.modelSelection).find(
          ([currentPurpose]) => currentPurpose === purpose,
        )?.[1] ?? [];
      for (const entry of entries) {
        const provider = current.providers[entry.providerId];
        if (!provider) {
          return failure(
            'referential_integrity',
            `Model selection '${purpose}' references unknown provider '${entry.providerId}'`,
          );
        }
        const instance = this.getInstance(entry.providerId);
        if (!instance.ok) return instance;
        const knownModel = provider.knownModels?.[entry.modelId];
        const definition = this.requireDefinition(provider.type);
        const maintainedMetadata = definition.resolveModelMetadata?.(
          entry.modelId,
        );
        const cached = this.modelCache.get(entry.providerId);
        const discovered =
          cached?.signature === this.settingsSignature(instance.value.settings)
            ? cached.models.find((model) => model.modelId === entry.modelId)
            : undefined;
        const alreadySelected = previousEntries.some(
          (previous) =>
            previous.providerId === entry.providerId &&
            previous.modelId === entry.modelId,
        );
        if (
          !alreadySelected &&
          !knownModel &&
          !hasTrustedModelMetadata(maintainedMetadata, discovered)
        ) {
          warnings.push({
            modelId: entry.modelId,
            message: `Capabilities for model '${entry.modelId}' could not be determined from provider discovery or the static catalog. Add it to knownModels to confirm its capabilities.`,
          });
        }
        const effective = this.resolveModel(entry);
        const voiceCapability = voiceCapabilityForPurpose(purpose);
        if (voiceCapability) {
          if (effective.capabilities.voice?.[voiceCapability] !== true) {
            return failure(
              'invalid_configuration',
              `Model '${entry.modelId}' does not declare voice.${voiceCapability} capability`,
            );
          }
          if (voiceCapability === 'sts' && provider.type !== 'openai') {
            return failure(
              'invalid_configuration',
              `Realtime speech requires an 'openai' provider, received '${provider.type}'`,
            );
          }
        } else if (
          purpose === 'imageVision' &&
          effective.inputCapabilities.image === undefined
        ) {
          return failure(
            'invalid_configuration',
            `Model '${entry.modelId}' does not declare image input capability`,
          );
        } else if (
          purpose === 'audioListening' &&
          effective.inputCapabilities.audio === undefined
        ) {
          return failure(
            'invalid_configuration',
            `Model '${entry.modelId}' does not declare audio input capability`,
          );
        } else if (
          effective.kind &&
          effective.kind !== 'language' &&
          effective.kind !== 'unknown'
        ) {
          return failure(
            'invalid_configuration',
            `Model '${entry.modelId}' has kind '${effective.kind}' and cannot be used for '${purpose}'`,
          );
        }
      }
    }
    try {
      await config.writeModelSelection(merged);
      return success({ selection: merged, warnings });
    } catch (error) {
      return failure('internal_error', sanitizedError(error));
    }
  }

  async listModels(
    id: ProviderInstanceId,
    refresh = false,
  ): Promise<ProviderOperationResult<readonly ResolvedProviderModel[]>> {
    const instance = this.getInstance(id);
    if (!instance.ok) return instance;
    const definition = this.requireDefinition(instance.value.type);
    const manual = Object.entries(instance.value.knownModels ?? {}).map(
      ([modelId, model]) => ({ modelId, ...model }),
    );
    const enrich = (model: ProviderModel): ProviderModel =>
      mergeProviderModels(
        {
          modelId: model.modelId,
          ...definition.resolveModelMetadata?.(model.modelId),
        },
        model,
      ) ?? model;
    if (!definition.discoverModels) {
      return success(
        manual.map((model) => ({
          ...enrich(model),
          provenance: [
            ...(enrich(model).provenance ?? []),
            { source: 'user' as const },
          ],
          source: 'manual' as const,
        })),
      );
    }
    const signature = this.settingsSignature(instance.value.settings);
    const cached = this.modelCache.get(id);
    let discovered =
      !refresh && cached?.signature === signature
        ? success(cached.models)
        : undefined;
    if (!discovered)
      discovered = await this.discover(
        id,
        definition,
        instance.value,
        signature,
      );
    if (!discovered.ok && cached?.signature === signature)
      discovered = success(cached.models);
    if (!discovered.ok) return discovered;
    const merged = new Map<string, ResolvedProviderModel>(
      discovered.value.map((model) => {
        const enriched = enrich(model);
        return [
          model.modelId,
          {
            ...enriched,
            provenance: [
              ...(enriched.provenance ?? []),
              { source: 'discovered' as const },
            ],
            source: 'discovered' as const,
          },
        ];
      }),
    );
    for (const model of manual) {
      const existing = merged.get(model.modelId);
      const combined = mergeProviderModels(existing, enrich(model));
      merged.set(model.modelId, {
        ...combined,
        modelId: model.modelId,
        provenance: [
          ...(combined?.provenance ?? []),
          { source: 'user' as const },
        ],
        source: existing ? 'merged' : 'manual',
      });
    }
    return success(
      [...merged.values()].sort((left, right) =>
        left.modelId.localeCompare(right.modelId),
      ),
    );
  }

  resolveRealtimeProvider(): ResolvedRealtimeProvider | undefined {
    this.assertStarted();
    const config = this.requireConfig();
    const resolved = config.resolveRealtimeProvider();
    if (!resolved) return undefined;
    const reference = config.get().modelSelection.voice.sts[0];
    if (!reference) return undefined;
    const model = this.resolveModel(reference);
    if (model.capabilities.voice?.sts !== true)
      throw new Error(
        `Model '${reference.modelId}' does not declare voice.sts capability`,
      );
    return resolved;
  }

  async testConnection(
    id: ProviderInstanceId,
  ): Promise<ProviderOperationResult<ProviderConnectionResult>> {
    const instance = this.getInstance(id);
    if (!instance.ok) return instance;
    const definition = this.requireDefinition(instance.value.type);
    return this.runHook((signal) =>
      definition.testConnection(instance.value, signal),
    );
  }

  getLanguageModel(reference: ModelSelectionEntry): LanguageModelV4 {
    this.assertStarted();
    this.resolveModel(reference);
    const instance = this.getInstance(reference.providerId);
    if (!instance.ok) throw new Error(instance.message);
    const definition = this.requireDefinition(instance.value.type);
    return definition.createLanguageModel(instance.value, reference.modelId);
  }

  resolveModel(reference: ModelSelectionEntry): ResolvedModelConfig {
    this.assertStarted();
    const config = this.requireConfig();
    const base = config.resolveModel(reference);
    const instance = this.getInstance(reference.providerId);
    if (!instance.ok) throw new Error(instance.message);
    const definition = this.requireDefinition(instance.value.type);
    const cached = this.modelCache.get(reference.providerId);
    const discovered =
      cached?.signature === this.settingsSignature(instance.value.settings)
        ? cached.models.find((model) => model.modelId === reference.modelId)
        : undefined;
    const user = instance.value.knownModels?.[reference.modelId];
    const maintained = definition.resolveModelMetadata?.(reference.modelId);
    const metadata = mergeProviderModels(
      {
        modelId: reference.modelId,
        ...maintained,
      },
      discovered,
      user ? { modelId: reference.modelId, ...user } : undefined,
    );
    return {
      ...base,
      ...(metadata?.kind && { kind: metadata.kind }),
      ...(metadata?.displayName && { displayName: metadata.displayName }),
      contextSize: metadata?.contextSize ?? base.contextSize,
      capabilities: metadata?.capabilities ?? base.capabilities,
      inputCapabilities:
        metadata?.capabilities?.input ?? base.inputCapabilities,
    };
  }

  resolveModelInfo(reference: ModelSelectionEntry): ModelInfo {
    const { capabilities, contextSize, displayName, inputCapabilities } =
      this.resolveModel(reference);
    return { capabilities, contextSize, displayName, inputCapabilities };
  }

  private async writeKnownModel(
    id: ProviderInstanceId,
    modelId: string,
    definition: ModelDefinition,
    mode: 'create' | 'update',
  ): Promise<ProviderOperationResult> {
    const config = this.requireConfig();
    const provider = config.get().providers[id];
    if (!provider) return failure('not_found', `Unknown provider '${id}'`);
    const exists = provider.knownModels?.[modelId] !== undefined;
    if (mode === 'create' && exists)
      return failure('conflict', `Known model '${modelId}' already exists`);
    if (mode === 'update' && !exists)
      return failure(
        'invalid_configuration',
        `Unknown known model '${modelId}'`,
      );
    try {
      await config.writeProviderInstance(id, {
        ...provider,
        knownModels: { ...provider.knownModels, [modelId]: definition },
      });
      this.modelCache.delete(id);
      return success(undefined);
    } catch (error) {
      return failure('internal_error', sanitizedError(error));
    }
  }

  private async discover(
    id: string,
    definition: ProviderDefinition,
    instance: ProviderInstance,
    signature: string,
  ): Promise<ProviderOperationResult<readonly ProviderModel[]>> {
    const pending = this.pendingDiscovery.get(id);
    if (pending) return pending;
    const { discoverModels } = definition;
    if (!discoverModels)
      return failure(
        'internal_error',
        'Provider does not support model discovery',
      );
    const generation = this.configGeneration;
    const request = this.runHook((signal) => discoverModels(instance, signal));
    this.pendingDiscovery.set(id, request);
    try {
      const result = await request;
      if (result.ok && generation === this.configGeneration) {
        this.modelCache.set(id, { signature, models: result.value });
        while (this.modelCache.size > 128) {
          const oldest = this.modelCache.keys().next().value;
          if (oldest === undefined) break;
          this.modelCache.delete(oldest);
        }
      }
      return result;
    } finally {
      if (this.pendingDiscovery.get(id) === request)
        this.pendingDiscovery.delete(id);
    }
  }

  private requireDefinition(type: ProviderType): ProviderDefinition {
    const definition = this.definitions.get(type);
    if (!definition) throw new Error(`Unknown provider type '${type}'`);
    return definition;
  }

  private getInstance(id: string): ProviderOperationResult<ProviderInstance> {
    const value = this.requireConfig().getRuntime().providers[id];
    if (!value) return failure('not_found', `Unknown provider '${id}'`);
    if (!this.definitions.has(value.type))
      return failure(
        'invalid_configuration',
        `Unknown provider type '${value.type}'`,
      );
    return success({ id, ...value });
  }

  private instanceInfo(instance: ProviderInstance): ProviderInstanceInfo {
    const definition = this.requireDefinition(instance.type);
    const removeBlocked = isProviderReferenced(
      this.requireConfig().get().modelSelection,
      instance.id,
    );
    return {
      id: instance.id,
      type: instance.type,
      settings: this.serializeSettings(instance.type, instance.settings),
      metadata: providerMetadata(definition),
      operations: {
        update: { available: true },
        remove: removeBlocked
          ? {
              available: false,
              code: 'referential_integrity',
              message: `Provider '${instance.id}' is referenced by model selection`,
              remediation:
                'Remove this provider from every model-selection purpose first.',
            }
          : { available: true },
      },
    };
  }

  private settingsSignature(settings: ProviderSettings): string {
    const serialized = JSON.stringify(
      Object.entries(settings).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    );
    return createHash('sha256')
      .update(this.signatureSalt)
      .update(serialized)
      .digest('hex');
  }

  private async runHook<T>(
    operation: (
      signal: AbortSignal,
    ) => Promise<ProviderOperationResult<T> | undefined>,
  ): Promise<ProviderOperationResult<T>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    timeout.unref?.();
    try {
      const result = await operation(controller.signal);
      return (
        result ?? failure('internal_error', 'Provider hook is unavailable')
      );
    } catch (error) {
      return failure('internal_error', sanitizedError(error));
    } finally {
      clearTimeout(timeout);
    }
  }

  private mutateExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const update = this.mutationQueue.then(operation);
    this.mutationQueue = update.then(
      () => undefined,
      () => undefined,
    );
    return update;
  }

  private requireConfig(): Config {
    this.assertStarted();
    if (!this.deps.config)
      throw new Error('Provider registry has no config dependency');
    return this.deps.config;
  }

  private assertStarted(): void {
    if (!this.started)
      throw new Error('Provider registry has not been started');
  }
}

function applySettingsPatch(
  current: ProviderSettings,
  patch: ProviderSettingsPatch | undefined,
): ProviderSettings {
  return mergePatch(current, patch ?? {});
}

function mergePatch(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete merged[key];
    } else if (isMergeObject(value)) {
      merged[key] = mergePatch(
        isMergeObject(merged[key]) ? merged[key] : {},
        value,
      );
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function isMergeObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateSettings(
  type: ProviderType,
  input: unknown,
): ProviderOperationResult<ProviderSettings> {
  try {
    return success(parseProviderSettings(type, input));
  } catch (error) {
    return failure('invalid_configuration', sanitizedError(error));
  }
}

function hasTrustedModelMetadata(
  maintained: Omit<ProviderModel, 'modelId'> | undefined,
  discovered: ProviderModel | undefined,
): boolean {
  return (
    discovered !== undefined ||
    maintained?.capabilities !== undefined ||
    maintained?.provenance?.some(
      ({ source }) =>
        source === 'provider-exact' || source === 'shared-catalog',
    ) === true
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function success<T>(value: T): ProviderOperationResult<T> {
  return { ok: true, code: 'available', value };
}

function failure(
  code: Exclude<ProviderErrorCode, 'available'>,
  message: string,
  remediation?: string,
): ProviderOperationFailure {
  return { ok: false, code, message, ...(remediation && { remediation }) };
}

function withoutId(instance: ProviderInstance): Omit<ProviderInstance, 'id'> {
  const { id: _id, ...stored } = instance;
  return stored;
}

function modelSelectionEntries(
  selection: ModelSelection,
): readonly (readonly [string, readonly ModelSelectionEntry[]])[] {
  return [
    ['chat', selection.chat],
    ['compaction', selection.compaction],
    ['memory', selection.memory],
    ['imageVision', selection.imageVision],
    ['audioListening', selection.audioListening],
    ['voice.sts', selection.voice.sts],
    ['voice.tts', selection.voice.tts],
    ['voice.stt', selection.voice.stt],
  ];
}

function voiceCapabilityForPurpose(
  purpose: string,
): 'sts' | 'tts' | 'stt' | undefined {
  if (purpose === 'voice.sts') return 'sts';
  if (purpose === 'voice.tts') return 'tts';
  if (purpose === 'voice.stt') return 'stt';
  return undefined;
}

function isProviderReferenced(
  selection: ModelSelection,
  providerId: string,
): boolean {
  return modelSelectionEntries(selection).some(([, entries]) =>
    entries.some((entry) => entry.providerId === providerId),
  );
}

function sanitizedError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return 'Provider operation timed out';
  }
  return 'Provider operation failed';
}

function providerMetadata(definition: ProviderDefinition): ProviderMetadata {
  return {
    ...definition.metadata,
    capabilities: {
      modelDiscovery: definition.discoverModels !== undefined,
      connectivityTest: true,
      customModels: true,
    },
  };
}

function validateDefinitions(
  definitions: readonly ProviderDefinition[],
): ReadonlyMap<ProviderType, ProviderDefinition> {
  const result = new Map<ProviderType, ProviderDefinition>();
  for (const definition of definitions) {
    if (!definition.type.trim()) {
      throw new Error('Provider type must not be empty');
    }
    if (result.has(definition.type)) {
      throw new Error(`Duplicate provider type '${definition.type}'`);
    }
    validateMetadata(definition);
    result.set(definition.type, Object.freeze(definition));
  }
  return result;
}

function validateMetadata(definition: ProviderDefinition): void {
  if (definition.usageGuidance.trim().length < 40) {
    throw new Error(
      `Provider '${definition.type}' must include complete usage guidance`,
    );
  }
  const logo = definition.metadata.logoSvg;
  if (
    logo !== undefined &&
    (!logo.startsWith('<svg') || /<script|\son\w+=|javascript:/i.test(logo))
  ) {
    throw new Error(`Provider '${definition.type}' has an unsafe SVG logo`);
  }
}

export function createProviderRegistry(
  deps: ProviderRegistryDependencies,
): ProviderRegistry {
  return new ProviderRegistryModule({
    logger: deps.logging.child({
      name: 'provider-registry',
      bindings: { module: 'provider-registry' },
    }),
    definitions: deps.definitions,
    ...(deps.config && { config: deps.config }),
  });
}
