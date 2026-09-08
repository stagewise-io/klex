import { join } from 'node:path';

import { ZodError } from 'zod';

import type { ModuleLogger, RootLogger } from '@stagewise/logger';

import {
  type LocalDataMetadata,
  readCurrentJsonStore,
  writeJsonStoreDocument,
} from '@/local-data';
import { KLEX_VERSION } from '@/release';

import { CONFIG_STORE_DEFINITION } from './storage-definition';
import {
  type KlexConfig,
  type McpServerConfig,
  type ModelCapabilities,
  type ModelInputCapabilities,
  type ModelKind,
  type ModelPurpose,
  type ModelSelection,
  type ModelSelectionEntry,
  type ProviderConfig,
  parseKlexConfig,
  type TelemetryLevel,
} from './types';

export const DEFAULT_CONTEXT_SIZE = 200_000;
export const CONFIG_FILE_NAME = 'config.json';

export interface ResolvedModelConfig {
  providerId: string;
  providerType: string;
  modelId: string;
  kind?: ModelKind;
  settings: Readonly<Record<string, unknown>>;
  contextSize: number;
  displayName?: string;
  capabilities: ModelCapabilities;
  inputCapabilities: ModelInputCapabilities;
  providerOptions?: Record<string, Record<string, unknown>>;
}

export interface ResolvedOpenAIRealtimeConfig {
  modelId: string;
  apiKey: string;
  websocketUrl: string;
}

export type ResolvedRealtimeProvider = {
  kind: 'openai-realtime';
  config: ResolvedOpenAIRealtimeConfig;
};

export interface ModelInfo {
  capabilities: ModelCapabilities;
  contextSize: number;
  displayName: string | undefined;
  inputCapabilities: ModelInputCapabilities;
}

export type ConfigValidationErrorCode =
  | 'not_found'
  | 'already_exists'
  | 'type_mismatch'
  | 'referential_integrity'
  | 'environment_missing'
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
  /** Returns the persisted view. Environment placeholders are never expanded here. */
  get(): Readonly<KlexConfig>;
  /** Returns an ephemeral deep clone with environment placeholders expanded. */
  getRuntime(): Readonly<KlexConfig>;
  replace(input: unknown): Promise<Readonly<KlexConfig>>;
  mutate(fn: (config: KlexConfig) => KlexConfig): Promise<Readonly<KlexConfig>>;
  subscribe(listener: ConfigListener): () => void;
  getModelSelection(purpose: ModelPurpose): readonly ModelSelectionEntry[];
  resolveModel(entry: ModelSelectionEntry): ResolvedModelConfig;
  resolveModelInfo(entry: ModelSelectionEntry): ModelInfo;
  getMcpServers(): Readonly<Record<string, McpServerConfig>>;
  resolveRealtimeProvider(): ResolvedRealtimeProvider | undefined;
  addMcpServer(
    name: string,
    server: McpServerConfig,
  ): Promise<Readonly<KlexConfig>>;
  updateMcpServer(
    name: string,
    server: McpServerConfig,
  ): Promise<Readonly<KlexConfig>>;
  removeMcpServer(name: string): Promise<Readonly<KlexConfig>>;
  writeModelSelection(selection: ModelSelection): Promise<Readonly<KlexConfig>>;
  writeProviderInstance(
    id: string,
    provider: ProviderConfig,
  ): Promise<Readonly<KlexConfig>>;
  deleteProviderInstance(id: string): Promise<Readonly<KlexConfig>>;
}

export interface ConfigDependencies {
  logging: RootLogger;
  dataDirectory: string;
  env?: Readonly<NodeJS.ProcessEnv>;
}

class ConfigModule implements Config {
  private config: KlexConfig | null = null;
  private metadata: LocalDataMetadata | undefined;
  private updateQueue: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<ConfigListener>();
  private readonly warnedMissingContextSize = new Set<string>();

  constructor(
    private readonly deps: {
      logger: ModuleLogger;
      configPath: string;
      dataDirectory: string;
      env: Readonly<NodeJS.ProcessEnv>;
    },
  ) {}

  async start(): Promise<void> {
    if (this.config) return;
    try {
      const document = await readCurrentJsonStore<KlexConfig>(
        this.deps.configPath,
        CONFIG_STORE_DEFINITION,
        this.deps.dataDirectory,
      );
      if (!document)
        throw new Error(
          `Required config file not found at ${this.deps.configPath}`,
        );
      const input = document.payload;
      this.metadata = document.metadata;
      const parsed = this.parse(input);
      this.config = parsed;
      if (JSON.stringify(input) !== JSON.stringify(parsed)) {
        await this.persist(parsed);
      }
    } catch (error) {
      this.config = null;
      if (
        error instanceof ConfigValidationError ||
        error instanceof ZodError ||
        error instanceof SyntaxError
      ) {
        throw new Error(
          `Config at ${this.deps.configPath} is invalid: ${safeErrorMessage(error)}`,
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

  getRuntime(): Readonly<KlexConfig> {
    return interpolateEnvironment(this.requireConfig(), this.deps.env);
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
    const update = this.updateQueue.then(() =>
      this.replaceNow(fn(this.requireConfig())),
    );
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
    const config = this.getRuntime();
    return config.modelSelection[purpose].filter((entry) =>
      this.isValidModelReference(config, entry),
    );
  }

  resolveModel(entry: ModelSelectionEntry): ResolvedModelConfig {
    const config = this.getRuntime();
    const provider = config.providers[entry.providerId];
    if (!provider) {
      throw new ConfigValidationError(
        `Model '${entry.modelId}' references unknown provider '${entry.providerId}'`,
        { code: 'not_found' },
      );
    }
    const definition = provider.knownModels?.[entry.modelId];
    const warningKey = `${entry.providerId}\u0000${entry.modelId}`;
    if (
      definition?.contextSize === undefined &&
      !this.warnedMissingContextSize.has(warningKey)
    ) {
      this.warnedMissingContextSize.add(warningKey);
      this.deps.logger.warn(
        { providerId: entry.providerId, modelId: entry.modelId },
        `Model does not specify contextSize — defaulting to ${DEFAULT_CONTEXT_SIZE}`,
      );
    }
    return {
      providerId: entry.providerId,
      providerType: provider.type,
      modelId: entry.modelId,
      ...(definition?.kind && { kind: definition.kind }),
      settings: provider.settings,
      contextSize: definition?.contextSize ?? DEFAULT_CONTEXT_SIZE,
      ...(definition?.displayName && { displayName: definition.displayName }),
      capabilities: definition?.capabilities ?? {},
      inputCapabilities: definition?.capabilities?.input ?? {},
      ...(entry.providerOptions && { providerOptions: entry.providerOptions }),
    };
  }

  resolveModelInfo(entry: ModelSelectionEntry): ModelInfo {
    const { capabilities, contextSize, displayName, inputCapabilities } =
      this.resolveModel(entry);
    return { capabilities, contextSize, displayName, inputCapabilities };
  }

  resolveRealtimeProvider(): ResolvedRealtimeProvider | undefined {
    const reference = this.getRuntime().modelSelection.voice.sts.find((entry) =>
      this.isValidModelReference(this.getRuntime(), entry),
    );
    if (!reference) return undefined;
    const resolved = this.resolveModel(reference);
    if (resolved.providerType !== 'openai') {
      throw new ConfigValidationError(
        `Realtime speech requires an 'openai' provider, received '${resolved.providerType}'`,
        { code: 'type_mismatch' },
      );
    }
    const apiKey = stringSetting(resolved.settings, 'apiKey');
    if (!apiKey) {
      throw new ConfigValidationError(
        'Realtime OpenAI provider requires an API key',
      );
    }
    const baseUrl =
      stringSetting(resolved.settings, 'baseUrl') ??
      'https://api.openai.com/v1';
    return {
      kind: 'openai-realtime',
      config: {
        modelId: resolved.modelId,
        apiKey,
        websocketUrl: openAIRealtimeWebSocketUrl(baseUrl, resolved.modelId),
      },
    };
  }

  getMcpServers(): Readonly<Record<string, McpServerConfig>> {
    return this.getRuntime().mcpServers;
  }

  async addMcpServer(
    name: string,
    server: McpServerConfig,
  ): Promise<Readonly<KlexConfig>> {
    return this.mutate((current) => {
      assertMissing(current.mcpServers, name, 'MCP server');
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
      assertPresent(current.mcpServers, name, 'MCP server');
      return {
        ...current,
        mcpServers: { ...current.mcpServers, [name]: server },
      };
    });
  }

  async removeMcpServer(name: string): Promise<Readonly<KlexConfig>> {
    return this.mutate((current) => {
      assertPresent(current.mcpServers, name, 'MCP server');
      const servers = { ...current.mcpServers };
      delete servers[name];
      return { ...current, mcpServers: servers };
    });
  }

  async writeModelSelection(
    selection: ModelSelection,
  ): Promise<Readonly<KlexConfig>> {
    return this.mutate((current) => ({
      ...current,
      modelSelection: selection,
    }));
  }

  async writeProviderInstance(
    id: string,
    provider: ProviderConfig,
  ): Promise<Readonly<KlexConfig>> {
    return this.mutate((current) => ({
      ...current,
      providers: { ...current.providers, [id]: provider },
    }));
  }

  async deleteProviderInstance(id: string): Promise<Readonly<KlexConfig>> {
    return this.mutate((current) => {
      const providers = { ...current.providers };
      delete providers[id];
      return { ...current, providers };
    });
  }

  private async replaceNow(input: unknown): Promise<Readonly<KlexConfig>> {
    this.requireConfig();
    const config = this.parse(input);
    await this.persist(config);
    this.config = config;
    this.deps.logger.info('Config updated');
    this.publish(config);
    return config;
  }

  private async persist(config: KlexConfig): Promise<void> {
    try {
      this.metadata = await writeJsonStoreDocument(
        this.deps.configPath,
        CONFIG_STORE_DEFINITION,
        config,
        KLEX_VERSION,
        this.metadata,
      );
    } catch (error) {
      throw new Error(`Failed to persist config at ${this.deps.configPath}`, {
        cause: error,
      });
    }
  }

  private parse(input: unknown): KlexConfig {
    try {
      const parsed = parseKlexConfig(input);
      // Validate interpolation without retaining the materialized secret-bearing view.
      interpolateEnvironment(parsed, this.deps.env);
      return parsed;
    } catch (error) {
      if (error instanceof ConfigValidationError) throw error;
      if (error instanceof ZodError) {
        throw new ConfigValidationError(error.message, { cause: error });
      }
      throw new ConfigValidationError(safeErrorMessage(error), {
        cause: error,
      });
    }
  }

  private isValidModelReference(
    config: Readonly<KlexConfig>,
    entry: ModelSelectionEntry,
  ): boolean {
    return config.providers[entry.providerId] !== undefined;
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

  private requireConfig(): KlexConfig {
    if (!this.config) throw new Error('Config has not been started');
    return this.config;
  }
}

/**
 * Recursively materializes `${env:NAME}` placeholders in string values only.
 * `$${env:NAME}` escapes a placeholder and becomes the literal `${env:NAME}`.
 */
export function interpolateEnvironment<T>(
  value: T,
  env: Readonly<NodeJS.ProcessEnv>,
): T {
  if (typeof value === 'string') {
    return interpolateString(value, env) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => interpolateEnvironment(item, env)) as T;
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        interpolateEnvironment(item, env),
      ]),
    ) as T;
  }
  return value;
}

function interpolateString(
  value: string,
  env: Readonly<NodeJS.ProcessEnv>,
): string {
  return value.replace(
    /(\$?)\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (_match, escaped: string, name: string) => {
      if (escaped === '$') return `\${env:${name}}`;
      const replacement = env[name];
      if (replacement === undefined) {
        throw new ConfigValidationError(
          `Required environment variable '${name}' is not defined`,
          { code: 'environment_missing' },
        );
      }
      return replacement;
    },
  );
}

function assertMissing(
  record: Readonly<Record<string, unknown>>,
  name: string,
  kind: string,
): void {
  if (record[name] !== undefined) {
    throw new ConfigValidationError(`${kind} '${name}' already exists`, {
      code: 'already_exists',
    });
  }
}

function assertPresent(
  record: Readonly<Record<string, unknown>>,
  name: string,
  kind: string,
): void {
  if (record[name] === undefined) {
    throw new ConfigValidationError(`${kind} '${name}' not found`, {
      code: 'not_found',
    });
  }
}

function stringSetting(
  settings: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = settings[key];
  return typeof value === 'string' ? value.trim() : undefined;
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Invalid configuration';
}

export function getDefaultTelemetryLevel(): TelemetryLevel {
  return process.env.NODE_ENV === 'production' ? 'reduced' : 'full';
}

export function openAIRealtimeWebSocketUrl(
  endpointUrl: string,
  modelId: string,
): string {
  const url = new URL(endpointUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/$/, '')}/realtime`;
  url.search = '';
  url.searchParams.set('model', modelId);
  return url.toString();
}

export function createConfig(deps: ConfigDependencies): Config {
  return new ConfigModule({
    logger: deps.logging.child({
      name: 'config',
      bindings: { module: 'config' },
    }),
    configPath: join(deps.dataDirectory, CONFIG_FILE_NAME),
    dataDirectory: deps.dataDirectory,
    env: deps.env ?? process.env,
  });
}
