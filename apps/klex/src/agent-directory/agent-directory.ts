import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { RootLogger } from '@stagewise/logger';

import { CONFIG_FILE_NAME, type KlexConfig, klexConfigSchema } from '@/config';
import { isDirectoryInUse } from '@/directory-lock';

const DIRECTORY_MODE = 0o700;

export interface DiscoveredAgent {
  directory: string;
  officialName: string;
  inUse: boolean;
}

export interface AgentDirectory {
  ensureRoot(): Promise<void>;
  discover(): Promise<DiscoveredAgent[]>;
  create(officialName: string): Promise<DiscoveredAgent>;
}

export interface AgentDirectoryDependencies {
  logging: RootLogger;
  rootDirectory: string;
}

class AgentDirectoryModule implements AgentDirectory {
  constructor(
    private readonly deps: {
      logger: Pick<ReturnType<RootLogger['child']>, 'warn'>;
      rootDirectory: string;
    },
  ) {}

  async ensureRoot(): Promise<void> {
    try {
      await mkdir(this.deps.rootDirectory, {
        recursive: true,
        mode: DIRECTORY_MODE,
      });
    } catch (error) {
      throw new Error(
        `Failed to create the agent storage directory at "${this.deps.rootDirectory}"`,
        { cause: error },
      );
    }
  }

  async discover(): Promise<DiscoveredAgent[]> {
    await this.ensureRoot();
    const entries = await readdir(this.deps.rootDirectory, {
      withFileTypes: true,
    });
    const agents: DiscoveredAgent[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directory = join(this.deps.rootDirectory, entry.name);
      try {
        const config = JSON.parse(
          await readFile(join(directory, CONFIG_FILE_NAME), 'utf8'),
        ) as unknown;
        const parsed = klexConfigSchema.parse(config);
        agents.push({
          directory,
          officialName: parsed.officialName,
          inUse: await isDirectoryInUse(directory),
        });
      } catch (error) {
        this.deps.logger.warn(
          { directory, error },
          'Skipping invalid agent directory during discovery',
        );
      }
    }

    return agents.sort((a, b) => a.officialName.localeCompare(b.officialName));
  }

  async create(officialName: string): Promise<DiscoveredAgent> {
    const name = validateAgentName(officialName);
    await this.ensureRoot();
    const directory = join(this.deps.rootDirectory, name);

    try {
      await mkdir(directory, { recursive: false, mode: DIRECTORY_MODE });
    } catch (error) {
      throw new Error(`Could not create agent directory "${name}"`, {
        cause: error,
      });
    }

    const config: KlexConfig = {
      officialName: name,
      providers: {},
      modelSelection: {
        chat: [],
        compaction: [],
        memory: [],
        imageVision: [],
        audioListening: [],
        voice: { sts: [], tts: [], stt: [] },
      },
      mcpServers: {},
    };
    const configPath = join(directory, CONFIG_FILE_NAME);
    const temporaryPath = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await rename(temporaryPath, configPath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      await rm(directory, { recursive: true, force: true }).catch(
        () => undefined,
      );
      throw new Error(`Could not initialize agent "${name}"`, { cause: error });
    }

    return { directory, officialName: name, inUse: false };
  }
}

function validateAgentName(value: string): string {
  const name = value.trim();
  if (
    name.length < 2 ||
    name === '.' ||
    name === '..' ||
    /[\\/\0]/.test(name)
  ) {
    throw new Error(
      'Agent name must be at least two characters and a single directory name',
    );
  }
  return name;
}

export function defaultAgentRoot(): string {
  return join(homedir(), '.klex', 'agents');
}

export function createAgentDirectory(
  deps: AgentDirectoryDependencies,
): AgentDirectory {
  return new AgentDirectoryModule({
    logger: deps.logging.child({
      name: 'agent-directory',
      bindings: { module: 'agent-directory' },
    }),
    rootDirectory: deps.rootDirectory,
  });
}
