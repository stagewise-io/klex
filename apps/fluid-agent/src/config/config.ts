import { randomUUID } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ZodError } from 'zod';
import type { ModuleLogger, RootLogger } from '../logger/logger';
import {
  type EndpointConfig,
  type FluidConfig,
  fluidConfigSchema,
  type McpServerConfig,
  type ModelEntry,
  type ModelId,
  type ModelPurpose,
} from './types';

export interface ResolvedModelConfig {
  providerId: string;
  endpointId: string;
  modelId: string;
  endpoint: EndpointConfig;
  model: ModelEntry;
}

export class ConfigValidationError extends Error {
  override readonly name = 'ConfigValidationError';
}

export interface Config {
  start(): Promise<void>;
  close(): Promise<void>;
  get(): Readonly<FluidConfig>;
  replace(input: unknown): Promise<Readonly<FluidConfig>>;
  getModelSelection(purpose: ModelPurpose): readonly ModelId[];
  resolveModel(modelId: ModelId): ResolvedModelConfig;
  getMcpServers(): Readonly<Record<string, McpServerConfig>>;
}

export interface ConfigDependencies {
  logging: RootLogger;
  dataDirectory: string;
}

class ConfigModule implements Config {
  private config: FluidConfig | null = null;
  private updateQueue: Promise<void> = Promise.resolve();

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
    this.config = null;
  }

  get(): Readonly<FluidConfig> {
    return this.requireConfig();
  }

  replace(input: unknown): Promise<Readonly<FluidConfig>> {
    const update = this.updateQueue.then(() => this.replaceNow(input));
    this.updateQueue = update.then(
      () => undefined,
      () => undefined,
    );
    return update;
  }

  getModelSelection(purpose: ModelPurpose): readonly ModelId[] {
    return this.requireConfig().modelSelection[purpose];
  }

  resolveModel(modelId: ModelId): ResolvedModelConfig {
    const config = this.requireConfig();
    const { providerId, endpointId, localModelId } = splitModelId(modelId);
    const endpoint = config.providers[providerId]?.endpoints[endpointId];
    const model = endpoint?.models?.[localModelId];

    if (!endpoint) {
      throw new Error(
        `Model ${modelId} references unknown endpoint ${providerId}:${endpointId}`,
      );
    }
    if (!model) {
      throw new Error(`Model ${modelId} is not configured at its endpoint`);
    }

    return {
      providerId,
      endpointId,
      modelId: localModelId,
      endpoint,
      model,
    };
  }

  getMcpServers(): Readonly<Record<string, McpServerConfig>> {
    return this.requireConfig().mcpServers;
  }

  private async replaceNow(input: unknown): Promise<Readonly<FluidConfig>> {
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
    return config;
  }

  private parse(input: unknown): FluidConfig {
    let config: FluidConfig;
    try {
      config = fluidConfigSchema.parse(input);
    } catch (error) {
      if (error instanceof ZodError) {
        throw new ConfigValidationError(error.message, { cause: error });
      }
      throw error;
    }

    try {
      this.validateModelReferences(config);
      this.validateHeaders(config);
    } catch (error) {
      if (error instanceof ConfigValidationError) throw error;
      throw new ConfigValidationError(
        error instanceof Error ? error.message : 'Invalid config',
        { cause: error },
      );
    }

    return config;
  }

  private requireConfig(): FluidConfig {
    if (!this.config) {
      throw new Error('Config has not been started');
    }
    return this.config;
  }

  private validateHeaders(config: FluidConfig): void {
    const providerHeaders = Object.values(config.providers).flatMap(
      (provider) =>
        Object.values(provider.endpoints).flatMap((endpoint) =>
          Object.values(endpoint.auth.headers ?? {}),
        ),
    );
    const mcpHeaders = Object.values(config.mcpServers).flatMap((server) =>
      'url' in server ? Object.values(server.headers ?? {}) : [],
    );

    if ([...providerHeaders, ...mcpHeaders].includes('[REDACTED]')) {
      throw new ConfigValidationError(
        'Header values must not use the reserved [REDACTED] marker',
      );
    }
  }

  private validateModelReferences(config: FluidConfig): void {
    for (const [purpose, modelIds] of Object.entries(config.modelSelection)) {
      for (const modelId of modelIds) {
        const { providerId, endpointId, localModelId } = splitModelId(modelId);
        const provider = config.providers[providerId];
        if (!provider) {
          throw new Error(
            `Model selection ${purpose} references unknown provider ${providerId}`,
          );
        }

        const endpoint = provider.endpoints[endpointId];
        if (!endpoint) {
          throw new Error(
            `Model selection ${purpose} references unknown endpoint ${providerId}:${endpointId}`,
          );
        }

        if (!endpoint.models?.[localModelId]) {
          throw new Error(
            `Model selection ${purpose} references unconfigured model ${modelId}`,
          );
        }
      }
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function splitModelId(modelId: ModelId): {
  providerId: string;
  endpointId: string;
  localModelId: string;
} {
  const firstColon = modelId.indexOf(':');
  const secondColon = modelId.indexOf(':', firstColon + 1);

  return {
    providerId: modelId.slice(0, firstColon),
    endpointId: modelId.slice(firstColon + 1, secondColon),
    localModelId: modelId.slice(secondColon + 1),
  };
}

export function createConfig(deps: ConfigDependencies): Config {
  return new ConfigModule({
    logger: deps.logging.child({
      name: 'config',
      bindings: { module: 'config' },
    }),
    configPath: join(deps.dataDirectory, '.fluid.json'),
  });
}
