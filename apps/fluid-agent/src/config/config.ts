import { readFile } from 'node:fs/promises';
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

export interface Config {
  start(): Promise<void>;
  close(): Promise<void>;
  get(): Readonly<FluidConfig>;
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
      const config = fluidConfigSchema.parse(input);
      this.validateModelReferences(config);
      this.config = config;
    } catch (error) {
      if (error instanceof ZodError) {
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

  private requireConfig(): FluidConfig {
    if (!this.config) {
      throw new Error('Config has not been started');
    }
    return this.config;
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
