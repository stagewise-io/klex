import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RootLogger } from '../logger/logger';
import { ConfigValidationError, createConfig } from './config';
import type { FluidConfig } from './types';

const directories: string[] = [];
const logging = {
  child: () => ({ info: () => undefined }),
} as unknown as RootLogger;

function validConfig(modelId = 'model:8b'): FluidConfig {
  return {
    providers: {
      local: {
        endpoints: {
          chat: {
            url: 'http://localhost:11434/v1',
            format: 'openai-chat-completions',
            auth: {},
            models: { [modelId]: {} },
          },
        },
      },
    },
    modelSelection: {
      chat: [`local:chat:${modelId}`],
      compression: [],
      memory: [],
    },
    mcpServers: {},
  };
}

async function setup(config = validConfig()) {
  const directory = await mkdtemp(join(tmpdir(), 'fluid-config-'));
  directories.push(directory);
  await writeFile(
    join(directory, '.fluid.json'),
    `${JSON.stringify(config, null, 2)}\n`,
  );
  const module = createConfig({ logging, dataDirectory: directory });
  await module.start();
  return { directory, module };
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('Config', () => {
  it('resolves model IDs whose local segment contains colons', async () => {
    const { module } = await setup();
    expect(module.resolveModel('local:chat:model:8b').modelId).toBe('model:8b');
  });

  it('atomically replaces persisted and active config', async () => {
    const { directory, module } = await setup();
    const next = validConfig('model:70b');

    await module.replace(next);

    expect(module.get()).toEqual(next);
    expect(
      JSON.parse(await readFile(join(directory, '.fluid.json'), 'utf8')),
    ).toEqual(next);
  });

  it('leaves prior state and file intact after invalid replacement', async () => {
    const { directory, module } = await setup();
    const before = await readFile(join(directory, '.fluid.json'), 'utf8');
    const invalid = validConfig();
    invalid.modelSelection.chat = ['missing:chat:model'];

    await expect(module.replace(invalid)).rejects.toBeInstanceOf(
      ConfigValidationError,
    );
    expect(module.get()).toEqual(validConfig());
    expect(await readFile(join(directory, '.fluid.json'), 'utf8')).toBe(before);
  });

  it('rejects redaction markers in provider and MCP headers', async () => {
    const { module } = await setup();
    const provider = validConfig();
    const endpoint = provider.providers.local?.endpoints.chat;
    if (!endpoint) throw new Error('Expected fixture endpoint');
    endpoint.auth.headers = { Authorization: '[REDACTED]' };
    await expect(module.replace(provider)).rejects.toBeInstanceOf(
      ConfigValidationError,
    );

    const mcp = validConfig();
    mcp.mcpServers.remote = {
      url: 'https://example.com/mcp',
      headers: { Authorization: '[REDACTED]' },
    };
    await expect(module.replace(mcp)).rejects.toBeInstanceOf(
      ConfigValidationError,
    );
  });

  it('serializes concurrent replacements', async () => {
    const { directory, module } = await setup();
    const first = validConfig('first');
    const second = validConfig('second');

    await Promise.all([module.replace(first), module.replace(second)]);

    expect(module.get()).toEqual(second);
    expect(
      JSON.parse(await readFile(join(directory, '.fluid.json'), 'utf8')),
    ).toEqual(second);
  });
});
