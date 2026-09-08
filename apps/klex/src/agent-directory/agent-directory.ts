import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { RootLogger } from '@stagewise/logger';

import {
  CONFIG_FILE_NAME,
  CONFIG_STORE_DEFINITION,
  type KlexConfig,
} from '@/config';
import { isDirectoryInUse } from '@/directory-lock';
import { readJsonStoreDocument, writeJsonStoreDocument } from '@/local-data';
import { KLEX_VERSION } from '@/release';

const DIRECTORY_MODE = 0o700;

export interface DiscoveredAgent {
  directory: string;
  officialName: string;
  inUse: boolean;
  compatibilityError?: string;
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
        const document = await readJsonStoreDocument(
          join(directory, CONFIG_FILE_NAME),
          CONFIG_STORE_DEFINITION,
          directory,
        );
        if (!document) continue;
        agents.push({
          directory,
          officialName: displayNameFromPayload(document.payload, entry.name),
          inUse: await isDirectoryInUse(directory),
        });
      } catch (error) {
        const officialName = await readDisplayName(
          join(directory, CONFIG_FILE_NAME),
          entry.name,
        );
        agents.push({
          directory,
          officialName,
          inUse: await isDirectoryInUse(directory),
          compatibilityError:
            error instanceof Error ? error.message : String(error),
        });
        this.deps.logger.warn(
          { directory, error },
          'Found incompatible agent directory during discovery',
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
      configVersion: 2,
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
    try {
      await writeJsonStoreDocument(
        configPath,
        CONFIG_STORE_DEFINITION,
        config,
        KLEX_VERSION,
      );
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(
        () => undefined,
      );
      throw new Error(`Could not initialize agent "${name}"`, { cause: error });
    }

    return { directory, officialName: name, inUse: false };
  }
}

function displayNameFromPayload(
  payload: Record<string, unknown>,
  fallback: string,
): string {
  if (typeof payload.officialName !== 'string') return fallback;
  return Array.from(payload.officialName.trim()).slice(0, 128).join('');
}

async function readDisplayName(
  configPath: string,
  fallback: string,
): Promise<string> {
  try {
    const value = JSON.parse(await readFile(configPath, 'utf8')) as unknown;
    if (
      typeof value === 'object' &&
      value !== null &&
      'officialName' in value &&
      typeof value.officialName === 'string'
    )
      return value.officialName;
  } catch {
    // The compatibility error returned by discovery carries the actionable detail.
  }
  return fallback;
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
