import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { RootLogger } from '@stagewise/logger';

import { createLocalData } from '@/local-data';
import { KLEX_VERSION } from '@/release';

import { CONFIG_FILE_NAME } from './config';
import { completeV4StoredConfig } from './config.test-fixtures';
import { CONFIG_STORE_DEFINITION } from './storage-definition';
import {
  admitOnDemandMcpConfig,
  getMcpServerLifecycle,
  mcpServerConfigSchema,
  parseStoredKlexConfigV5,
} from './types';

const directories: string[] = [];
const logging = {
  child: () => ({
    error: () => undefined,
    info: () => undefined,
    warn: () => undefined,
  }),
} as unknown as RootLogger;

const machineUrl = 'https://cloud.example/machines/m1/mcp';
const lifecycle = {
  mode: 'on-demand',
  catalogUrl: 'https://cloud.example/api/machines/m1/lifecycle',
} as const;

function v5Document(mcpServers: Record<string, unknown>) {
  const {
    episodeFinishIdleTriggerTimeMs: _idle,
    memoryWriteIntervalMs: _interval,
    memoryWriteStepInterval: _step,
    ...v5Body
  } = completeV4StoredConfig;
  return {
    _klex: {
      store: 'config',
      schemaVersion: 5,
      compatibilityVersion: 6,
      minimumKlexVersion: '0.9.2',
      writtenByKlexVersion: '0.13.3',
    },
    ...v5Body,
    extensions: {
      memory: {
        episodes: {
          maxCharacters: 50_000,
          maxDurationMs: 3_600_000,
          idleTimeoutMs: 450_000,
        },
      },
    },
    mcpServers,
  };
}

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'klex-config-on-demand-'));
  directories.push(path);
  return path;
}

async function start(
  dataDirectory: string,
  definition = CONFIG_STORE_DEFINITION,
) {
  await createLocalData({
    logging,
    dataDirectory,
    klexVersion: KLEX_VERSION,
    stores: [definition],
  }).start();
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('on-demand MCP lifecycle', () => {
  it('accepts a same-origin on-demand HTTP server', () => {
    const server = mcpServerConfigSchema.parse({ url: machineUrl, lifecycle });
    expect(getMcpServerLifecycle(server)).toEqual(lifecycle);
  });

  it('treats servers without a descriptor as always-on', () => {
    expect(
      getMcpServerLifecycle(mcpServerConfigSchema.parse({ url: machineUrl })),
    ).toBeUndefined();
    expect(
      getMcpServerLifecycle(mcpServerConfigSchema.parse({ command: 'node' })),
    ).toBeUndefined();
  });

  it('rejects a catalog on another origin', () => {
    const result = mcpServerConfigSchema.safeParse({
      url: machineUrl,
      lifecycle: { ...lifecycle, catalogUrl: 'https://evil.example/catalog' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown modes, unknown keys, and non-HTTP catalogs', () => {
    for (const candidate of [
      { mode: 'standby', catalogUrl: lifecycle.catalogUrl },
      { ...lifecycle, wakeUrl: lifecycle.catalogUrl },
      { mode: 'on-demand', catalogUrl: 'file:///etc/passwd' },
    ]) {
      expect(
        mcpServerConfigSchema.safeParse({
          url: machineUrl,
          lifecycle: candidate,
        }).success,
      ).toBe(false);
    }
  });

  it('rejects a lifecycle on a stdio server', () => {
    expect(
      mcpServerConfigSchema.safeParse({ command: 'node', lifecycle }).success,
    ).toBe(false);
  });

  it('keeps stored schema 5 frozen against the descriptor', () => {
    const { _klex, ...body } = v5Document({
      machine: { url: machineUrl, lifecycle },
    });
    expect(() => parseStoredKlexConfigV5(body)).toThrow();
    expect(() => admitOnDemandMcpConfig(body)).toThrow();
  });

  it('migrates a schema 5 file without rewriting servers', async () => {
    const dataDirectory = await directory();
    const configPath = join(dataDirectory, CONFIG_FILE_NAME);
    const servers = {
      machine: { url: machineUrl, headers: { Authorization: 'Bearer token' } },
      local: { command: 'node', args: ['server.js'] },
    };
    await writeFile(configPath, JSON.stringify(v5Document(servers)));

    await start(dataDirectory);

    const persisted = JSON.parse(await readFile(configPath, 'utf8')) as {
      _klex: Record<string, unknown>;
      mcpServers: unknown;
    };
    expect(persisted._klex).toMatchObject({
      schemaVersion: 6,
      compatibilityVersion: 7,
      minimumKlexVersion: '0.14.0',
    });
    expect(persisted.mcpServers).toEqual(servers);
  });

  it('refuses an older reader before it can drop the descriptor', async () => {
    const dataDirectory = await directory();
    const configPath = join(dataDirectory, CONFIG_FILE_NAME);
    await writeFile(configPath, JSON.stringify(v5Document({})));
    await start(dataDirectory);
    const before = await readFile(configPath);

    const olderDefinition = {
      ...CONFIG_STORE_DEFINITION,
      schemaVersion: 5,
      compatibilityVersion: 6,
      minimumKlexVersion: '0.9.2',
      versions: CONFIG_STORE_DEFINITION.versions.slice(0, 5),
      migrations: CONFIG_STORE_DEFINITION.migrations.slice(0, 4),
    };
    await expect(
      createLocalData({
        logging,
        dataDirectory,
        klexVersion: '0.13.3',
        stores: [olderDefinition],
      }).start(),
    ).rejects.toThrow();
    expect(await readFile(configPath)).toEqual(before);
  });
});
