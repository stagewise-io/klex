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
  type McpServerConfig,
  type ModelId,
  type ModelPurpose,
  type ModelSelection,
  resolvePresetEndpoint,
} from './types';

/**
 * Default context size (in tokens) assumed when a model definition does
 * not specify an explicit `contextSize`.
 */
export const DEFAULT_CONTEXT_SIZE = 200_000;

export interface ResolvedModelConfig {
  providerId: string;
  endpointId: string;
  modelId: string;
  endpoint: EndpointConfig;
  isPreset: boolean;
  contextSize: number;
  /** Human-readable name from knownModels, if declared. */
  displayName?: string;
}

export class ConfigValidationError extends Error {
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
  subscribe(listener: ConfigListener): () => void;
  getModelSelection(purpose: ModelPurpose): readonly ModelId[];
  resolveModel(modelId: ModelId): ResolvedModelConfig;
  /**
   * Returns the context size (in tokens) for a given model ID. If the
   * model definition does not specify `contextSize`, returns
   * {@link DEFAULT_CONTEXT_SIZE}.
   */
  getModelContextSize(modelId: ModelId): number;
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

  subscribe(listener: ConfigListener): () => void {
    this.requireConfig();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getModelSelection(purpose: ModelPurpose): readonly ModelId[] {
    return this.requireConfig().modelSelection[purpose];
  }

  resolveModel(modelId: ModelId): ResolvedModelConfig {
    const config = this.requireConfig();
    const { providerId, rest } = splitProviderId(modelId);
    const provider = config.providers[providerId];

    if (!provider) {
      throw new Error(
        `Model ${modelId} references unknown provider ${providerId}`,
      );
    }

    if ('preset' in provider) {
      const localModelId = rest;
      const endpoint = resolvePresetEndpoint(provider.preset, provider.auth);
      const contextSize = resolveContextSize(
        provider.knownModels,
        localModelId,
      );
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
        providerId,
        endpointId: provider.preset,
        modelId: localModelId,
        endpoint: resolveAuthEnvVars(endpoint),
        isPreset: true,
        contextSize: contextSize ?? DEFAULT_CONTEXT_SIZE,
        displayName: resolveDisplayName(provider.knownModels, localModelId),
      };
    }

    const colon = rest.indexOf(':');
    if (colon === -1) {
      throw new Error(
        `Manual provider ${providerId} requires an endpoint ID; use ${providerId}:endpointId:modelId format`,
      );
    }

    const endpointId = rest.slice(0, colon);
    const localModelId = rest.slice(colon + 1);
    const endpoint = provider.endpoints[endpointId];

    if (!endpoint) {
      throw new Error(
        `Model ${modelId} references unknown endpoint ${providerId}:${endpointId}`,
      );
    }

    const contextSize = resolveContextSize(endpoint.knownModels, localModelId);
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
      providerId,
      endpointId,
      modelId: localModelId,
      endpoint: resolveAuthEnvVars(endpoint),
      isPreset: false,
      contextSize: contextSize ?? DEFAULT_CONTEXT_SIZE,
      displayName: resolveDisplayName(endpoint.knownModels, localModelId),
    };
  }

  getModelContextSize(modelId: ModelId): number {
    return this.resolveModel(modelId).contextSize;
  }

  getMcpServers(): Readonly<Record<string, McpServerConfig>> {
    return this.requireConfig().mcpServers;
  }

  async addMcpServer(
    name: string,
    server: McpServerConfig,
  ): Promise<Readonly<KlexConfig>> {
    const current = this.requireConfig();
    if (current.mcpServers[name]) {
      throw new ConfigValidationError(`MCP server '${name}' already exists`);
    }
    const updated: KlexConfig = {
      ...current,
      mcpServers: { ...current.mcpServers, [name]: server },
    };
    return this.replace(updated);
  }

  async updateMcpServer(
    name: string,
    server: McpServerConfig,
  ): Promise<Readonly<KlexConfig>> {
    const current = this.requireConfig();
    if (!current.mcpServers[name]) {
      throw new ConfigValidationError(`MCP server '${name}' not found`);
    }
    const updated: KlexConfig = {
      ...current,
      mcpServers: { ...current.mcpServers, [name]: server },
    };
    return this.replace(updated);
  }

  async removeMcpServer(name: string): Promise<Readonly<KlexConfig>> {
    const current = this.requireConfig();
    if (!current.mcpServers[name]) {
      throw new ConfigValidationError(`MCP server '${name}' not found`);
    }
    const { [name]: _removed, ...remaining } = current.mcpServers;
    const updated: KlexConfig = {
      ...current,
      mcpServers: remaining,
    };
    return this.replace(updated);
  }

  private async replaceNow(input: unknown): Promise<Readonly<KlexConfig>> {
    this.requireConfig();
    const config = this.parse(input);
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

  private parse(input: unknown): KlexConfig {
    let config: KlexConfig;
    try {
      config = klexConfigSchema.parse(input);
    } catch (error) {
      if (error instanceof ZodError) {
        throw new ConfigValidationError(error.message, { cause: error });
      }
      throw error;
    }

    try {
      this.validateModelReferences(config);
      this.validateAuth(config);
    } catch (error) {
      if (error instanceof ConfigValidationError) throw error;
      throw new ConfigValidationError(
        error instanceof Error ? error.message : 'Invalid config',
        { cause: error },
      );
    }

    return config;
  }

  async updateModelSelection(
    selection: ModelSelection,
  ): Promise<Readonly<KlexConfig>> {
    const current = this.requireConfig();
    const updated: KlexConfig = {
      ...current,
      modelSelection: selection,
    };
    return this.replace(updated);
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
      );
    }
  }

  private validateModelReferences(config: KlexConfig): void {
    for (const [purpose, modelIds] of Object.entries(config.modelSelection)) {
      for (const modelId of modelIds) {
        const { providerId, rest } = splitProviderId(modelId);
        const provider = config.providers[providerId];
        if (!provider) {
          throw new Error(
            `Model selection ${purpose} references unknown provider ${providerId}`,
          );
        }

        if ('preset' in provider) {
          // Preset providers accept any model name — the API rejects invalid ones.
          continue;
        }

        const colon = rest.indexOf(':');
        if (colon === -1) {
          throw new Error(
            `Model selection ${purpose} references provider ${providerId} without an endpoint ID; use ${providerId}:endpointId:modelId format`,
          );
        }

        const endpointId = rest.slice(0, colon);
        const endpoint = provider.endpoints[endpointId];
        if (!endpoint) {
          throw new Error(
            `Model selection ${purpose} references unknown endpoint ${providerId}:${endpointId}`,
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

/**
 * Looks up the `contextSize` for a model in an optional `knownModels`
 * record. Returns `undefined` when the model or its `contextSize` is not
 * declared — callers should default to {@link DEFAULT_CONTEXT_SIZE}.
 */
function resolveContextSize(
  models: Record<string, { contextSize?: number }> | undefined,
  localModelId: string,
): number | undefined {
  return models?.[localModelId]?.contextSize;
}

/**
 * Looks up the `displayName` for a model in an optional `knownModels`
 * record. Returns `undefined` when the model or its `displayName` is not
 * declared.
 */
function resolveDisplayName(
  models: Record<string, { displayName?: string }> | undefined,
  localModelId: string,
): string | undefined {
  return models?.[localModelId]?.displayName;
}

export function createConfig(deps: ConfigDependencies): Config {
  return new ConfigModule({
    logger: deps.logging.child({
      name: 'config',
      bindings: { module: 'config' },
    }),
    configPath: join(deps.dataDirectory, '.klex.json'),
  });
}
