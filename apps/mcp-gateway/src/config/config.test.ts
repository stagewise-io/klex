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
      new URL('../../mcp-gateway.config.example.json', import.meta.url),
    );
    const config = createConfig(path);

    expect(
      config.authenticateAgent('REPLACE_WITH_A_UNIQUE_AGENT_TOKEN'),
    ).toBeDefined();
    expect(
      config.authenticateEnvironment(
        'REPLACE_WITH_A_UNIQUE_MACBOOK_ENVIRONMENT_TOKEN',
      ),
    ).toBeDefined();
  });

  it('resolves principals and explicit grants across tenants', async () => {
    const config = createConfig(
      await configFile({
        host: '127.0.0.1',
        port: 3000,
        tenants: [
          tenant(
            'alpha',
            'agent-a',
            'agent-token-a',
            [
              environment('macbook', 'environment-token-a'),
              environment('linux', 'environment-token-b'),
            ],
            ['macbook'],
          ),
          tenant(
            'beta',
            'agent-b',
            'agent-token-b',
            [environment('server', 'environment-token-c')],
            ['server'],
          ),
        ],
      }),
    );

    const agent = config.authenticateAgent('agent-token-a');
    const macbook = config.authenticateEnvironment('environment-token-a');
    const linux = config.authenticateEnvironment('environment-token-b');
    const otherTenant = config.authenticateEnvironment('environment-token-c');

    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(3000);
    expect(agent).toMatchObject({ agentId: 'agent-a', tenantId: 'alpha' });
    expect(macbook).toMatchObject({
      environmentId: 'macbook',
      tenantId: 'alpha',
    });
    if (!agent || !macbook || !linux || !otherTenant) {
      throw new Error('Expected configured principals');
    }
    expect(config.authorize(agent, macbook)).toBe(true);
    expect(config.authorize(agent, linux)).toBe(false);
    expect(config.authorize(agent, otherTenant)).toBe(false);
    expect(config.authenticateAgent('unknown')).toBeUndefined();
    expect(config.authenticateEnvironment(undefined)).toBeUndefined();
    expect(config.parseEnvironmentId('server')).toBe('server');
    expect(() => config.parseEnvironmentId('unknown')).toThrow(
      'Unknown environment',
    );
  });

  it('rejects missing files and malformed JSON without exposing contents', async () => {
    expect(() => createConfig('/missing/gateway-config.json')).toThrow(
      'Cannot read MCP gateway config',
    );
    const path = await rawConfigFile('{ secret-token');
    expect(() => createConfig(path)).toThrow(
      'Invalid JSON in MCP gateway config',
    );
  });

  it.each([
    ['empty tenants', { host: 'localhost', port: 3000, tenants: [] }],
    [
      'empty agents',
      {
        host: 'localhost',
        port: 3000,
        tenants: [
          {
            tenantId: 'local',
            agents: [],
            environments: [environment('mac', 'env')],
          },
        ],
      },
    ],
    [
      'empty environments',
      {
        host: 'localhost',
        port: 3000,
        tenants: [{ tenantId: 'local', agents: [{}], environments: [] }],
      },
    ],
    ['invalid port', { host: 'localhost', port: 70_000, tenants: [{}] }],
    ['invalid host', { host: ' ', port: 3000, tenants: [{}] }],
  ])('rejects %s', async (_name, input) => {
    const path = await configFile(input);
    expect(() => createConfig(path)).toThrow('Invalid MCP gateway config');
  });

  it.each([
    [
      'duplicate tenant IDs',
      {
        host: 'localhost',
        port: 3000,
        tenants: [
          tenant(
            'local',
            'a',
            'a-token',
            [environment('a-env', 'a-env-token')],
            [],
          ),
          tenant(
            'local',
            'b',
            'b-token',
            [environment('b-env', 'b-env-token')],
            [],
          ),
        ],
      },
    ],
    [
      'duplicate agent IDs',
      {
        host: 'localhost',
        port: 3000,
        tenants: [
          {
            tenantId: 'local',
            agents: [
              { agentId: 'agent', token: 'one', environmentGrants: [] },
              { agentId: 'agent', token: 'two', environmentGrants: [] },
            ],
            environments: [environment('mac', 'env')],
          },
        ],
      },
    ],
    [
      'duplicate environment IDs',
      {
        host: 'localhost',
        port: 3000,
        tenants: [
          tenant(
            'local',
            'agent',
            'agent-token',
            [environment('mac', 'one'), environment('mac', 'two')],
            [],
          ),
        ],
      },
    ],
    [
      'duplicate tokens across principal kinds',
      {
        host: 'localhost',
        port: 3000,
        tenants: [
          tenant(
            'local',
            'agent',
            'shared',
            [environment('mac', 'shared')],
            [],
          ),
        ],
      },
    ],
    [
      'duplicate grants',
      {
        host: 'localhost',
        port: 3000,
        tenants: [
          tenant(
            'local',
            'agent',
            'agent-token',
            [environment('mac', 'env-token')],
            ['mac', 'mac'],
          ),
        ],
      },
    ],
    [
      'unknown or cross-tenant grants',
      {
        host: 'localhost',
        port: 3000,
        tenants: [
          tenant(
            'one',
            'agent',
            'agent-token',
            [environment('mac', 'mac-token')],
            ['server'],
          ),
          tenant(
            'two',
            'other',
            'other-token',
            [environment('server', 'server-token')],
            [],
          ),
        ],
      },
    ],
  ])('rejects %s', async (_name, input) => {
    const path = await configFile(input);
    expect(() => createConfig(path)).toThrow('Invalid MCP gateway config');
  });
});

function tenant(
  tenantId: string,
  agentId: string,
  token: string,
  environments: unknown[],
  environmentGrants: string[],
): unknown {
  return {
    tenantId,
    agents: [{ agentId, token, environmentGrants }],
    environments,
  };
}

function environment(environmentId: string, token: string): unknown {
  return { environmentId, token };
}

async function configFile(input: unknown): Promise<string> {
  return rawConfigFile(JSON.stringify(input));
}

async function rawConfigFile(contents: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-gateway-config-'));
  directories.push(directory);
  const path = join(directory, 'config.json');
  await writeFile(path, contents);
  return path;
}
