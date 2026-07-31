import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { createConfig } from './config';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe('createConfig', () => {
  it('accepts the committed example configuration', () => {
    const path = fileURLToPath(
      new URL('../../mcp-proxy.config.example.json', import.meta.url),
    );
    const config = createConfig(path);

    expect(
      config.authenticateEnvironment(
        'REPLACE_WITH_A_UNIQUE_MACBOOK_ENVIRONMENT_TOKEN',
      ),
    ).toBeDefined();
  });

  it('resolves globally unique environment IDs and tokens', async () => {
    const config = createConfig(
      await configFile({
        host: '127.0.0.1',
        port: 3000,
        environments: [
          environment('macbook', 'environment-token-a'),
          environment('server', 'environment-token-b'),
        ],
      }),
    );

    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(3000);
    expect(config.authenticateEnvironment('environment-token-a')).toBe(
      'macbook',
    );
    expect(config.authenticateEnvironment('unknown')).toBeUndefined();
    expect(config.authenticateEnvironment(undefined)).toBeUndefined();
    expect(config.parseEnvironmentId('server')).toBe('server');
    expect(() => config.parseEnvironmentId('unknown')).toThrow(
      'Unknown environment',
    );
  });

  it('rejects missing files and malformed JSON without exposing contents', async () => {
    expect(() => createConfig('/missing/proxy-config.json')).toThrow(
      'Cannot read MCP proxy config',
    );
    const path = await rawConfigFile('{ secret-token');
    expect(() => createConfig(path)).toThrow(
      'Invalid JSON in MCP proxy config',
    );
  });

  it.each([
    ['empty environments', { host: 'localhost', port: 3000, environments: [] }],
    ['invalid port', { host: 'localhost', port: 70_000, environments: [{}] }],
    ['invalid host', { host: ' ', port: 3000, environments: [{}] }],
  ])('rejects %s', async (_name, input) => {
    const path = await configFile(input);
    expect(() => createConfig(path)).toThrow('Invalid MCP proxy config');
  });

  it.each([
    [
      'duplicate environment IDs',
      {
        host: 'localhost',
        port: 3000,
        environments: [environment('mac', 'one'), environment('mac', 'two')],
      },
    ],
    [
      'duplicate environment tokens',
      {
        host: 'localhost',
        port: 3000,
        environments: [
          environment('mac', 'same'),
          environment('linux', 'same'),
        ],
      },
    ],
  ])('rejects %s', async (_name, input) => {
    const path = await configFile(input);
    expect(() => createConfig(path)).toThrow('Invalid MCP proxy config');
  });
});

function environment(environmentId: string, token: string): unknown {
  return { environmentId, token };
}

async function configFile(input: unknown): Promise<string> {
  return rawConfigFile(JSON.stringify(input));
}

async function rawConfigFile(contents: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-proxy-config-'));
  directories.push(directory);
  const path = join(directory, 'config.json');
  await writeFile(path, contents);
  return path;
}
