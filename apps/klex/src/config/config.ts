import { randomUUID } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ZodError } from 'zod';

import type { ModuleLogger, RootLogger } from '@stagewise/logger';

import {
  type EndpointAuth,
  type EndpointConfig,
  type KlexConfig,
  klexConfigSchema,
  type ManualEndpoint,
  type McpServerConfig,
  type ModelDefinition,
  type ModelId,
  type ModelInputCapabilities,
  type ModelPurpose,
  type ModelSelection,
  type ModelSelectionEntry,
  modelIdFromEntry,
  type ProviderConfig,
  resolvePresetEndpoint,
  type TelemetryLevel,
} from './types';

/**
 * Default context size (in tokens) assumed when a model definition does
 * not specify an explicit `contextSize`.
 */
export const DEFAULT_CONTEXT_SIZE = 200_000;

/**
 * File name used for the persisted agent configuration file.
 */
export const CONFIG_FILE_NAME = 'config.json';

/**
 * Returns the environment-aware default telemetry level:
 * `'reduced'` in production, `'full'` otherwise.
 */
export function getDefaultTelemetryLevel(): TelemetryLevel {
  return process.env.NODE_ENV === 'production' ? 'reduced' : 'full';
}

export interface ResolvedModelConfig {
  providerId: string;
  endpointId: string;
  modelId: string;
  endpoint: EndpointConfig;
  isPreset: boolean;
  contextSize: number;
  /** Human-readable name from knownModels, if declared. */
  displayName?: string;
  inputCapabilities: ModelInputCapabilities;
  /** Provider-specific options from the model selection entry. */
  providerOptions?: Record<string, unknown>;
}

/**
 * Model metadata with fallbacks applied. Every consumer of model info
 * gets this — no need to handle missing fields individually.
 */
export interface ModelInfo {
  /** Resolved context size in tokens (defaults to {@link DEFAULT_CONTEXT_SIZE}). */
  contextSize: number;
  /** Human-readable name from `knownModels`, if declared. */
  displayName: string | undefined;
  /** Native input formats accepted by this model. */
  inputCapabilities: ModelInputCapabilities;
}

export type ConfigValidationErrorCode =
  | 'not_found'
  | 'already_exists'
  | 'type_mismatch'
  | 'referential_integrity'
  | 'validation';

export class ConfigValidationError extends Error {
  readonly code: ConfigValidationErrorCode;

  constructor(
    message: string,
    options?: ErrorOptions & { code?: ConfigValidationErrorCode },
  ) {
    super(message, options);
    this.code = options?.code ?? 'validation';
  }

  override readonly name = 'ConfigValidationError';
}

export type ConfigListener = (
  config: Readonly<KlexConfig>,
) => void | Promise<void>;

export interface Config {
  start(): Promise<void>;
  close(): Promise<void>;
  get(): Readonly<KlexConfig>;
  replace(input: unknown): Promise<Readonly<KlexConfig>>;
  /**
   * Atomically reads the current config, applies the transform function, and
   * persists the result. The read-merge-write cycle runs inside the update
   * queue, preventing lost updates from concurrent mutations.
   * Throws if the config has not been started.
   */
  mutate(fn: (config: KlexConfig) => KlexConfig): Promise<Readonly<KlexConfig>>;
  subscribe(listener: ConfigListener): () => void;
  getModelSelection(purpose: ModelPurpose): readonly ModelSelectionEntry[];
  resolveModel(entry: ModelSelectionEntry): ResolvedModelConfig;
  /**
   * Returns all model metadata for a given model entry with fallbacks
   * applied (e.g. `contextSize` defaults to {@link DEFAULT_CONTEXT_SIZE}).
   */
  resolveModelInfo(entry: ModelSelectionEntry): ModelInfo;
  getMcpServers(): Readonly<Record<string, McpServerConfig>>;
  /** Creates a new MCP server. Throws if the name already exists. */
  addMcpServer(
    name: string,
    server: McpServerConfig,
  ): Promise<Readonly<KlexConfig>>;
  /** Updates (replaces) an existing MCP server by name. Throws if not found. */
  updateMcpServer(
    name: string,
    server: McpServerConfig,
  ): Promise<Readonly<KlexConfig>>;
  /** Removes a single MCP server by name. Throws if not found. */
  removeMcpServer(name: string): Promise<Readonly<KlexConfig>>;
  /** Updates the model selection section of the config. */
  updateModelSelection(
    selection: ModelSelection,
  ): Promise<Readonly<KlexConfig>>;
  /** Creates a new provider. Throws if the name already exists. */
  addProvider(
    name: string,
    provider: ProviderConfig,
  ): Promise<Readonly<KlexConfig>>;
  /** Updates (replaces) an existing provider by name. Throws if not found. */
  updateProvider(
    name: string,
    provider: ProviderConfig,
  ): Promise<Readonly<KlexConfig>>;
  /** Removes a provider and all its endpoints. Throws if not found. */
  removeProvider(name: string): Promise<Readonly<KlexConfig>>;
  /** Creates a new endpoint on a manual provider. Throws if provider not found, is preset, or endpoint exists. */
  addEndpoint(
    providerName: string,
    endpointName: string,
    endpoint: EndpointConfig,
  ): Promise<Readonly<KlexConfig>>;
  /** Updates an endpoint on a manual provider. Throws if provider/endpoint not found or is preset. */
  updateEndpoint(
    providerName: string,
    endpointName: string,
    endpoint: EndpointConfig,
  ): Promise<Readonly<KlexConfig>>;
  /** Removes an endpoint from a manual provider. Throws if provider/endpoint not found or is preset. */
  removeEndpoint(
    providerName: string,
    endpointName: string,
  ): Promise<Readonly<KlexConfig>>;
  /** Adds a known model to a provider. For preset providers, omit endpointName. For manual providers, endpointName is required. Throws on duplicate modelId. */
  addKnownModel(
    providerName: string,
    modelId: string,
    definition: ModelDefinition,
    endpointName?: string,
  ): Promise<Readonly<KlexConfig>>;
  /** Updates a known model definition. For manual providers, endpointName is required. Throws if not found. */
  updateKnownModel(
    providerName: string,
    modelId: string,
    definition: ModelDefinition,
    endpointName?: string,
  ): Promise<Readonly<KlexConfig>>;
  /** Removes a known model. For manual providers, endpointName is required. Throws if not found. */
  removeKnownModel(
    providerName: string,
    modelId: string,
    endpointName?: string,
  ): Promise<Readonly<KlexConfig>>;
}

export interface ConfigDependencies {
  logging: RootLogger;
  dataDirectory: string;
}

class ConfigModule implements Config {
  private config: KlexConfig | null = null;
  private updateQueue: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<ConfigListener>();
  /** Tracks models already warned about missing contextSize. */
  private readonly warnedMissingContextSize = new Set<ModelId>();

  constructor(
    private readonly deps: {
      logger: ModuleLogger;
      configPath: string;
    },
  ) {}

  async start(): Promise<void> {
    if (this.config) return;

    let source: string;
    try {
      source = await readFile(this.deps.configPath, 'utf8');
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        throw new Error(
          `Required config file not found at ${this.deps.configPath}`,
          { cause: error },
        );
      }

      throw new Error(`Failed to read config at ${this.deps.configPath}`, {
        cause: error,
      });
    }

    let input: unknown;
    try {
      input = JSON.parse(source);
    } catch (error) {
      throw new Error(`Config at ${this.deps.configPath} is not valid JSON`, {
        cause: error,
      });
    }

    try {
      this.config = this.parse(input);
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        throw new Error(
          `Config at ${this.deps.configPath} is invalid: ${error.message}`,
          { cause: error },
        );
      }
      throw error;
    }

    this.deps.logger.info(
      { configPath: this.deps.configPath },
      'Config loaded',
    );
  }

  async close(): Promise<void> {
    this.listeners.clear();
    this.config = null;
  }

  get(): Readonly<KlexConfig> {
    return this.requireConfig();
  }

  replace(input: unknown): Promise<Readonly<KlexConfig>> {
    const update = this.updateQueue.then(() => this.replaceNow(input));
    this.updateQueue = update.then(
      () => undefined,
      () => undefined,
    );
    return update;
  }

  mutate(
    fn: (config: KlexConfig) => KlexConfig,
  ): Promise<Readonly<KlexConfig>> {
    const update = this.updateQueue.then(async () => {
      const current = this.requireConfig();
      const next = fn(current);
      return this.replaceNow(next, false);
    });
    this.updateQueue = update.then(
      () => undefined,
      () => undefined,
    );
    return update;
  }

  subscribe(listener: ConfigListener): () => void {
    this.requireConfig();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getModelSelection(purpose: ModelPurpose): readonly ModelSelectionEntry[] {
    return this.requireConfig().modelSelection[purpose];
  }

  resolveModel(entry: ModelSelectionEntry): ResolvedModelConfig {
    const modelId = modelIdFromEntry(entry);
    const config = this.requireConfig();
    const { providerId, rest } = splitProviderId(modelId);
    const provider = config.providers[providerId];

    if (!provider) {
      throw new Error(
        `Model ${modelId} references unknown provider ${providerId}`,
      );
    }

    let knownModels: Record<string, ModelDefinition> | undefined;
    let localModelId: string;
    let endpointConfig: EndpointConfig;

    if ('preset' in provider) {
      localModelId = rest;
      knownModels = provider.knownModels;
      endpointConfig = resolvePresetEndpoint(provider.preset, provider.auth);
      const info = this.resolveMetadata(
        modelId,
        providerId,
        knownModels,
        localModelId,
      );
      return {
        providerId,
        endpointId: provider.preset,
        modelId: localModelId,
        endpoint: resolveAuthEnvVars(endpointConfig),
        isPreset: true,
        ...info,
        providerOptions: this.resolveProviderOptions(entry),
      };
    }

    const colon = rest.indexOf(':');
    if (colon === -1) {
      throw new Error(
        `Manual provider ${providerId} requires an endpoint ID; use ${providerId}:endpointId:modelId format`,
      );
    }

    const endpointId = rest.slice(0, colon);
    localModelId = rest.slice(colon + 1);
    const endpoint = provider.endpoints[endpointId];

    if (!endpoint) {
      throw new Error(
        `Model ${modelId} references unknown endpoint ${providerId}:${endpointId}`,
      );
    }

    knownModels = endpoint.knownModels;
    endpointConfig = endpoint;
    const info = this.resolveMetadata(
      modelId,
      providerId,
      knownModels,
      localModelId,
    );
    return {
      providerId,
      endpointId,
      modelId: localModelId,
      endpoint: resolveAuthEnvVars(endpointConfig),
      isPreset: false,
      ...info,
      providerOptions: this.resolveProviderOptions(entry),
    };
  }

  resolveModelInfo(entry: ModelSelectionEntry): ModelInfo {
    const { contextSize, displayName, inputCapabilities } =
      this.resolveModel(entry);
    return { contextSize, displayName, inputCapabilities };
  }

  /**
   * Returns the providerOptions from the selection entry, or undefined
   * if the entry is a bare string or has no providerOptions set.
   */
  private resolveProviderOptions(
    entry: ModelSelectionEntry,
  ): Record<string, unknown> | undefined {
    if (typeof entry === 'string') return undefined;
    return entry.providerOptions;
  }

  /**
   * Resolves metadata (contextSize + displayName) from `knownModels`,
   * applying the {@link DEFAULT_CONTEXT_SIZE} fallback and warning.
   */
  private resolveMetadata(
    modelId: ModelId,
    providerId: string,
    knownModels: Record<string, ModelDefinition> | undefined,
    localModelId: string,
  ): ModelInfo {
    const def = knownModels?.[localModelId];
    const contextSize = def?.contextSize;
    if (
      contextSize === undefined &&
      !this.warnedMissingContextSize.has(modelId)
    ) {
      this.warnedMissingContextSize.add(modelId);
      this.deps.logger.warn(
        { modelId, providerId },
        `Model ${modelId} does not specify contextSize — defaulting to ${DEFAULT_CONTEXT_SIZE}. Explicit contextSize is preferred.`,
      );
    }

    return {
      contextSize: contextSize ?? DEFAULT_CONTEXT_SIZE,
      displayName: def?.displayName,
      inputCapabilities: def?.inputCapabilities ?? {},
    };
  }

  getMcpServers(): Readonly<Record<string, McpServerConfig>> {
    const servers = structuredClone(this.requireConfig().mcpServers);
    for (const server of Object.values(servers)) {
      if (!('url' in server) || server.headers === undefined) continue;
      server.headers = Object.fromEntries(
        Object.entries(server.headers).map(([name, value]) => [
          name,
          resolveEnvVar(value),
        ]),
      ) as Record<string, string>;
    }
    return servers;
  }

  async addMcpServer(
    name: string,
    server: McpServerConfig,
  ): Promise<Readonly<KlexConfig>> {
    return this.mutate((current) => {
      if (current.mcpServers[name]) {
        throw new ConfigValidationError(`MCP server '${name}' already exists`, {
          code: 'already_exists',
        });
      }
      return {
        ...current,
        mcpServers: { ...current.mcpServers, [name]: server },
      };
    });
  }

  async updateMcpServer(
    name: string,
    server: McpServerConfig,
  ): Promise<Readonly<KlexConfig>> {
    return this.mutate((current) => {
      if (!current.mcpServers[name]) {
        throw new ConfigValidationError(`MCP server '${name}' not found`, {
          code: 'not_found',
        });
      }
      return {
        ...current,
        mcpServers: { ...current.mcpServers, [name]: server },
      };
    });
  }

  async removeMcpServer(name: string): Promise<Readonly<KlexConfig>> {
    return this.mutate((current) => {
      if (!current.mcpServers[name]) {
        throw new ConfigValidationError(`MCP server '${name}' not found`, {
          code: 'not_found',
        });
      }
      const { [name]: _removed, ...remaining } = current.mcpServers;
      return {
        ...current,
        mcpServers: remaining,
      };
    });
  }

  private async replaceNow(
    input: unknown,
    validateReferences = true,
  ): Promise<Readonly<KlexConfig>> {
    this.requireConfig();
    const config = this.parse(input, validateReferences);
    const temporaryPath = `${this.deps.configPath}.${process.pid}.${randomUUID()}.tmp`;

    try {
      await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await rename(temporaryPath, this.deps.configPath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw new Error(`Failed to persist config at ${this.deps.configPath}`, {
        cause: error,
      });
    }

    this.config = config;
    this.deps.logger.info('Config updated');
    this.publish(config);
    return config;
  }

  private publish(config: Readonly<KlexConfig>): void {
    for (const listener of this.listeners) {
      try {
        void Promise.resolve(listener(config)).catch((error: unknown) => {
          this.deps.logger.error({ error }, 'Config subscriber failed');
        });
      } catch (error) {
        this.deps.logger.error({ error }, 'Config subscriber failed');
      }
    }
  }

  private parse(input: unknown, validateReferences = true): KlexConfig {
    let config: KlexConfig;
    try {
      config = klexConfigSchema.parse(input);
    } catch (error) {
      if (error instanceof ZodError) {
        throw new ConfigValidationError(error.message, {
          cause: error,
          code: 'validation',
        });
      }
      throw error;
    }

    try {
      if (validateReferences) {
        this.validateModelReferences(config);
      }
      this.validateAuth(config);
    } catch (error) {
      if (error instanceof ConfigValidationError) throw error;
      throw new ConfigValidationError(
        error instanceof Error ? error.message : 'Invalid config',
        { cause: error, code: 'validation' },
      );
    }

    return config;
  }

  async updateModelSelection(
    selection: ModelSelection,
  ): Promise<Readonly<KlexConfig>> {
    return this.mutate((current) => ({
      ...current,
      modelSelection: selection,
    }));
  }

  async addProvider(
    name: string,
    provider: ProviderConfig,
  ): Promise<Readonly<KlexConfig>> {
    return this.mutate((current) => {
      if (current.providers[name]) {
        throw new ConfigValidationError(`Provider '${name}' already exists`, {
          code: 'already_exists',
        });
      }
      return {
        ...current,
        providers: { ...current.providers, [name]: provider },
      };
    });
  }

  async updateProvider(
    name: string,
    provider: ProviderConfig,
  ): Promise<Readonly<KlexConfig>> {
    return this.mutate((current) => {
      if (!current.providers[name]) {
        throw new ConfigValidationError(`Provider '${name}' not found`, {
          code: 'not_found',
        });
      }
      return {
        ...current,
        providers: { ...current.providers, [name]: provider },
      };
    });
  }

  async removeProvider(name: string): Promise<Readonly<KlexConfig>> {
    return this.mutate((current) => {
      if (!current.providers[name]) {
        throw new ConfigValidationError(`Provider '${name}' not found`, {
          code: 'not_found',
        });
      }
      // Check referential integrity before removal
      for (const [purpose, entries] of Object.entries(current.modelSelection)) {
        for (const entry of entries) {
          const modelId = modelIdFromEntry(entry);
          const { providerId } = splitProviderId(modelId);
          if (providerId === name) {
            throw new ConfigValidationError(
              `Cannot delete provider '${name}' because it is still referenced by model selection '${purpose}'`,
              { code: 'referential_integrity' },
            );
          }
        }
      }
      const { [name]: _removed, ...remaining } = current.providers;
      return {
        ...current,
        providers: remaining,
      };
    });
  }

  async addEndpoint(
    providerName: string,
    endpointName: string,
    endpoint: EndpointConfig,
  ): Promise<Readonly<KlexConfig>> {
    return this.mutate((current) => {
      const provider = current.providers[providerName];
      if (!provider) {
        throw new ConfigValidationError(
          `Provider '${providerName}' not found`,
          { code: 'not_found' },
        );
      }
      if ('preset' in provider) {
        throw new ConfigValidationError(
          `Cannot add endpoints to preset provider '${providerName}'`,
          { code: 'type_mismatch' },
        );
      }
      if (provider.endpoints[endpointName]) {
        throw new ConfigValidationError(
          `Endpoint '${endpointName}' already exists in provider '${providerName}'`,
          { code: 'already_exists' },
        );
      }
      return {
        ...current,
        providers: {
          ...current.providers,
          [providerName]: {
            endpoints: {
              ...provider.endpoints,
              [endpointName]: endpoint,
            },
          },
        },
      };
    });
  }

  async updateEndpoint(
    providerName: string,
    endpointName: string,
    endpoint: EndpointConfig,
  ): Promise<Readonly<KlexConfig>> {
    return this.mutate((current) => {
      const provider = current.providers[providerName];
      if (!provider) {
        throw new ConfigValidationError(
          `Provider '${providerName}' not found`,
          { code: 'not_found' },
        );
      }
      if ('preset' in provider) {
        throw new ConfigValidationError(
          `Cannot update endpoints on preset provider '${providerName}'`,
          { code: 'type_mismatch' },
        );
      }
      const ep = provider.endpoints[endpointName];
      if (!ep) {
        throw new ConfigValidationError(
          `Endpoint '${endpointName}' not found in provider '${providerName}'`,
          { code: 'not_found' },
        );
      }
      const merged: ManualEndpoint = {
        ...endpoint,
        ...('knownModels' in ep && ep.knownModels
          ? { knownModels: ep.knownModels }
          : {}),
      };
      return {
        ...current,
        providers: {
          ...current.providers,
          [providerName]: {
            endpoints: { ...provider.endpoints, [endpointName]: merged },
          },
        },
      };
    });
  }

  async removeEndpoint(
    providerName: string,
    endpointName: string,
  ): Promise<Readonly<KlexConfig>> {
    return this.mutate((current) => {
      const provider = current.providers[providerName];
      if (!provider) {
        throw new ConfigValidationError(
          `Provider '${providerName}' not found`,
          { code: 'not_found' },
        );
      }
      if ('preset' in provider) {
        throw new ConfigValidationError(
          `Cannot remove endpoints from preset provider '${providerName}'`,
          { code: 'type_mismatch' },
        );
      }
      if (!provider.endpoints[endpointName]) {
        throw new ConfigValidationError(
          `Endpoint '${endpointName}' not found in provider '${providerName}'`,
          { code: 'not_found' },
        );
      }
      // Check referential integrity before removal
      for (const [purpose, entries] of Object.entries(current.modelSelection)) {
        for (const entry of entries) {
          const modelId = modelIdFromEntry(entry);
          const { providerId, rest } = splitProviderId(modelId);
          if (providerId === providerName) {
            const colon = rest.indexOf(':');
            if (colon !== -1 && rest.slice(0, colon) === endpointName) {
              throw new ConfigValidationError(
                `Cannot delete endpoint '${providerName}:${endpointName}' because it is still referenced by model selection '${purpose}'`,
                { code: 'referential_integrity' },
              );
            }
          }
        }
      }
      const { [endpointName]: _removed, ...remainingEndpoints } =
        provider.endpoints;
      return {
        ...current,
        providers: {
          ...current.providers,
          [providerName]: {
            endpoints: remainingEndpoints,
          },
        },
      };
    });
  }

  async addKnownModel(
    providerName: string,
    modelId: string,
    definition: ModelDefinition,
    endpointName?: string,
  ): Promise<Readonly<KlexConfig>> {
    return this.mutate((current) => {
      const provider = current.providers[providerName];
      if (!provider) {
        throw new ConfigValidationError(
          `Provider '${providerName}' not found`,
          { code: 'not_found' },
        );
      }

      if ('preset' in provider) {
        if (endpointName !== undefined) {
          throw new ConfigValidationError(
            `Preset provider '${providerName}' does not support endpoint-scoped known models`,
            { code: 'type_mismatch' },
          );
        }
        const existing = provider.knownModels ?? {};
        if (existing[modelId]) {
          throw new ConfigValidationError(
            `Model '${modelId}' already exists in provider '${providerName}'`,
            { code: 'already_exists' },
          );
        }
        return {
          ...current,
          providers: {
            ...current.providers,
            [providerName]: {
              ...provider,
              knownModels: { ...existing, [modelId]: definition },
            },
          },
        };
      }

      // Manual provider — endpointName is required
      if (!endpointName) {
        throw new ConfigValidationError(
          `Manual provider '${providerName}' requires an endpoint name for known models`,
          { code: 'type_mismatch' },
        );
      }
      const endpoint = provider.endpoints[endpointName];
      if (!endpoint) {
        throw new ConfigValidationError(
          `Endpoint '${endpointName}' not found in provider '${providerName}'`,
          { code: 'not_found' },
        );
      }
      const existing = endpoint.knownModels ?? {};
      if (existing[modelId]) {
        throw new ConfigValidationError(
          `Model '${modelId}' already exists in endpoint '${endpointName}' of provider '${providerName}'`,
          { code: 'already_exists' },
        );
      }
      return {
        ...current,
        providers: {
          ...current.providers,
          [providerName]: {
            endpoints: {
              ...provider.endpoints,
              [endpointName]: {
                ...endpoint,
                knownModels: { ...existing, [modelId]: definition },
              },
            },
          },
        },
      };
    });
  }

  async updateKnownModel(
    providerName: string,
    modelId: string,
    definition: ModelDefinition,
    endpointName?: string,
  ): Promise<Readonly<KlexConfig>> {
    return this.mutate((current) => {
      const provider = current.providers[providerName];
      if (!provider) {
        throw new ConfigValidationError(
          `Provider '${providerName}' not found`,
          { code: 'not_found' },
        );
      }

      if ('preset' in provider) {
        if (endpointName !== undefined) {
          throw new ConfigValidationError(
            `Preset provider '${providerName}' does not support endpoint-scoped known models`,
            { code: 'type_mismatch' },
          );
        }
        const existing = provider.knownModels ?? {};
        if (!existing[modelId]) {
          throw new ConfigValidationError(
            `Model '${modelId}' not found in provider '${providerName}'`,
            { code: 'not_found' },
          );
        }
        return {
          ...current,
          providers: {
            ...current.providers,
            [providerName]: {
              ...provider,
              knownModels: { ...existing, [modelId]: definition },
            },
          },
        };
      }

      // Manual provider — endpointName is required
      if (!endpointName) {
        throw new ConfigValidationError(
          `Manual provider '${providerName}' requires an endpoint name for known models`,
          { code: 'type_mismatch' },
        );
      }
      const endpoint = provider.endpoints[endpointName];
      if (!endpoint) {
        throw new ConfigValidationError(
          `Endpoint '${endpointName}' not found in provider '${providerName}'`,
          { code: 'not_found' },
        );
      }
      const existing = endpoint.knownModels ?? {};
      if (!existing[modelId]) {
        throw new ConfigValidationError(
          `Model '${modelId}' not found in endpoint '${endpointName}' of provider '${providerName}'`,
          { code: 'not_found' },
        );
      }
      return {
        ...current,
        providers: {
          ...current.providers,
          [providerName]: {
            endpoints: {
              ...provider.endpoints,
              [endpointName]: {
                ...endpoint,
                knownModels: { ...existing, [modelId]: definition },
              },
            },
          },
        },
      };
    });
  }

  async removeKnownModel(
    providerName: string,
    modelId: string,
    endpointName?: string,
  ): Promise<Readonly<KlexConfig>> {
    return this.mutate((current) => {
      const provider = current.providers[providerName];
      if (!provider) {
        throw new ConfigValidationError(
          `Provider '${providerName}' not found`,
          { code: 'not_found' },
        );
      }

      if ('preset' in provider) {
        if (endpointName !== undefined) {
          throw new ConfigValidationError(
            `Preset provider '${providerName}' does not support endpoint-scoped known models`,
            { code: 'type_mismatch' },
          );
        }
        const existing = provider.knownModels ?? {};
        if (!existing[modelId]) {
          throw new ConfigValidationError(
            `Model '${modelId}' not found in provider '${providerName}'`,
            { code: 'not_found' },
          );
        }
        const { [modelId]: _removed, ...remaining } = existing;
        return {
          ...current,
          providers: {
            ...current.providers,
            [providerName]: {
              ...provider,
              knownModels:
                Object.keys(remaining).length > 0 ? remaining : undefined,
            },
          },
        };
      }

      // Manual provider — endpointName is required
      if (!endpointName) {
        throw new ConfigValidationError(
          `Manual provider '${providerName}' requires an endpoint name for known models`,
          { code: 'type_mismatch' },
        );
      }
      const endpoint = provider.endpoints[endpointName];
      if (!endpoint) {
        throw new ConfigValidationError(
          `Endpoint '${endpointName}' not found in provider '${providerName}'`,
          { code: 'not_found' },
        );
      }
      const existing = endpoint.knownModels ?? {};
      if (!existing[modelId]) {
        throw new ConfigValidationError(
          `Model '${modelId}' not found in endpoint '${endpointName}' of provider '${providerName}'`,
          { code: 'not_found' },
        );
      }
      const { [modelId]: _removed, ...remaining } = existing;
      return {
        ...current,
        providers: {
          ...current.providers,
          [providerName]: {
            endpoints: {
              ...provider.endpoints,
              [endpointName]: {
                ...endpoint,
                knownModels:
                  Object.keys(remaining).length > 0 ? remaining : undefined,
              },
            },
          },
        },
      };
    });
  }

  private requireConfig(): KlexConfig {
    if (!this.config) {
      throw new Error('Config has not been started');
    }
    return this.config;
  }

  private validateAuth(config: KlexConfig): void {
    const providerAuthValues = Object.values(config.providers).flatMap(
      (provider) => {
        const authValues: string[] = [];
        if ('preset' in provider) {
          if (provider.auth.apiKey) authValues.push(provider.auth.apiKey);
          authValues.push(...Object.values(provider.auth.headers ?? {}));
        } else {
          for (const endpoint of Object.values(provider.endpoints)) {
            if (endpoint.auth.apiKey) authValues.push(endpoint.auth.apiKey);
            authValues.push(...Object.values(endpoint.auth.headers ?? {}));
          }
        }
        return authValues;
      },
    );
    const mcpHeaders = Object.values(config.mcpServers).flatMap((server) =>
      'url' in server ? Object.values(server.headers ?? {}) : [],
    );

    if ([...providerAuthValues, ...mcpHeaders].includes('[REDACTED]')) {
      throw new ConfigValidationError(
        'Auth values must not use the reserved [REDACTED] marker',
        { code: 'validation' },
      );
    }
  }

  private validateModelReferences(config: KlexConfig): void {
    for (const [purpose, entries] of Object.entries(config.modelSelection)) {
      for (const entry of entries) {
        const modelId = modelIdFromEntry(entry);
        const { providerId, rest } = splitProviderId(modelId);
        const provider = config.providers[providerId];
        if (!provider) {
          throw new ConfigValidationError(
            `Model selection ${purpose} references unknown provider ${providerId}`,
            { code: 'referential_integrity' },
          );
        }

        if ('preset' in provider) {
          // Preset providers accept any model name — the API rejects invalid ones.
          continue;
        }

        const colon = rest.indexOf(':');
        if (colon === -1) {
          throw new ConfigValidationError(
            `Model selection ${purpose} references provider ${providerId} without an endpoint ID; use ${providerId}:endpointId:modelId format`,
            { code: 'referential_integrity' },
          );
        }

        const endpointId = rest.slice(0, colon);
        const endpoint = provider.endpoints[endpointId];
        if (!endpoint) {
          throw new ConfigValidationError(
            `Model selection ${purpose} references unknown endpoint ${providerId}:${endpointId}`,
            { code: 'referential_integrity' },
          );
        }
      }
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function splitProviderId(modelId: ModelId): {
  providerId: string;
  rest: string;
} {
  const colon = modelId.indexOf(':');
  return {
    providerId: modelId.slice(0, colon),
    rest: modelId.slice(colon + 1),
  };
}

const ENV_VAR_PATTERN = /^\{env:\s*(.+?)\s*\}$/;

function resolveEnvVar(value: string | undefined): string | undefined {
  if (!value) return value;
  const match = value.match(ENV_VAR_PATTERN);
  if (!match) return value;
  // biome-ignore lint/style/noNonNullAssertion: capture group guaranteed by regex match
  const varName = match[1]!.trim();
  const envValue = process.env[varName];
  if (envValue === undefined) {
    throw new Error(`Environment variable ${varName} is not set`);
  }
  return envValue;
}

function resolveAuthEnvVars(endpoint: EndpointConfig): EndpointConfig {
  const auth: EndpointAuth = { ...endpoint.auth };
  if (auth.apiKey !== undefined) {
    auth.apiKey = resolveEnvVar(auth.apiKey);
  }
  return { ...endpoint, auth };
}

export function createConfig(deps: ConfigDependencies): Config {
  return new ConfigModule({
    logger: deps.logging.child({
      name: 'config',
      bindings: { module: 'config' },
    }),
    configPath: join(deps.dataDirectory, CONFIG_FILE_NAME),
  });
}
