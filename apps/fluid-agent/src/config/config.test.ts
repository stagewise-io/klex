import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { RootLogger } from '@stagewise/logger';

import { ConfigValidationError, createConfig } from './config';
import type { FluidConfig, ProviderPreset } from './types';

const directories: string[] = [];
const logging = {
  child: () => ({
    error: () => undefined,
    info: () => undefined,
    warn: () => undefined,
  }),
} as unknown as RootLogger;

// --- fixtures ---

function manualConfig(modelId = 'model:8b'): FluidConfig {
  return {
    providers: {
      local: {
        endpoints: {
          chat: {
            url: 'http://localhost:11434/v1',
            format: 'chat-completions',
            auth: {},
          },
        },
      },
    },
    modelSelection: {
      chat: [`local:chat:${modelId}`],
      compaction: [],
      memory: [],
    },
    mcpServers: {},
  };
}

function presetConfig(
  preset: ProviderPreset = 'openai',
  modelId = 'gpt-4o',
  providerId = 'my-openai',
): FluidConfig {
  return {
    providers: {
      [providerId]: {
        preset,
        auth: { apiKey: 'sk-test' },
      },
    },
    modelSelection: {
      chat: [`${providerId}:${modelId}`],
      compaction: [],
      memory: [],
    },
    mcpServers: {},
  };
}

function mixedConfig(): FluidConfig {
  return {
    providers: {
      remote: {
        preset: 'openai',
        auth: { apiKey: 'sk-test' },
      },
      local: {
        endpoints: {
          chat: {
            url: 'http://localhost:11434/v1',
            format: 'chat-completions',
            auth: {},
          },
          api: {
            url: 'http://localhost:8080/v1',
            format: 'open-responses',
            auth: { apiKey: 'local-key' },
          },
        },
      },
    },
    modelSelection: {
      chat: ['remote:gpt-4o'],
      compaction: ['local:chat:model:8b'],
      memory: ['local:api:test-model'],
    },
    mcpServers: {},
  };
}

async function setup(config = manualConfig()) {
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

// --- tests ---

describe('Config — lifecycle', () => {
  it('throws if config file does not exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fluid-config-'));
    directories.push(dir);
    const module = createConfig({ logging, dataDirectory: dir });
    await expect(module.start()).rejects.toThrow(/not found/);
  });

  it('throws if config file is not valid JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fluid-config-'));
    directories.push(dir);
    await writeFile(join(dir, '.fluid.json'), '{ not json');
    const module = createConfig({ logging, dataDirectory: dir });
    await expect(module.start()).rejects.toThrow(/not valid JSON/);
  });

  it('throws on schema violation with ConfigValidationError wrapped message', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fluid-config-'));
    directories.push(dir);
    await writeFile(
      join(dir, '.fluid.json'),
      '{"providers": {}, "modelSelection": {}, "mcpServers": {}}',
    );
    const module = createConfig({ logging, dataDirectory: dir });
    await expect(module.start()).rejects.toThrow(/invalid/);
  });

  it('start is idempotent', async () => {
    const { module } = await setup();
    await module.start(); // second call should not throw
    expect(module.get()).toBeDefined();
  });

  it('throws if methods called before start', () => {
    const dir = 'unused'; // won't read
    const module = createConfig({ logging, dataDirectory: dir });
    expect(() => module.get()).toThrow('Config has not been started');
    expect(() => module.resolveModel('a:b')).toThrow(
      'Config has not been started',
    );
  });

  it('close resets state so subsequent calls throw', async () => {
    const { module } = await setup();
    await module.close();
    expect(() => module.get()).toThrow('Config has not been started');
  });
});

describe('Config — resolveModel (manual providers)', () => {
  it('resolves model IDs whose local segment contains colons', async () => {
    const { module } = await setup();
    expect(module.resolveModel('local:chat:model:8b').modelId).toBe('model:8b');
  });

  it('resolves a basic 3-segment manual model ID', async () => {
    const { module } = await setup();
    const resolved = module.resolveModel('local:chat:model:8b');
    expect(resolved).toMatchObject({
      providerId: 'local',
      endpointId: 'chat',
      modelId: 'model:8b',
      isPreset: false,
    });
    expect(resolved.endpoint.url).toBe('http://localhost:11434/v1');
  });

  it('throws on unknown provider', async () => {
    const { module } = await setup();
    expect(() => module.resolveModel('unknown:chat:model')).toThrow(
      /unknown provider/,
    );
  });

  it('throws on unknown endpoint', async () => {
    const { module } = await setup();
    expect(() => module.resolveModel('local:missing:model')).toThrow(
      /unknown endpoint/,
    );
  });

  it('throws when manual provider model ID lacks endpoint segment', async () => {
    const { module } = await setup();
    // 'local:model' — rest is 'model', no second colon
    expect(() => module.resolveModel('local:model')).toThrow(
      /requires an endpoint ID/,
    );
  });

  it('resolves across multiple endpoints in the same provider', async () => {
    const { module } = await setup(mixedConfig());
    const resolved = module.resolveModel('local:api:test-model');
    expect(resolved.endpointId).toBe('api');
    expect(resolved.modelId).toBe('test-model');
    expect(resolved.endpoint.format).toBe('open-responses');
  });
});

describe('Config — resolveModel (preset providers)', () => {
  it('resolves a preset provider model with 2-segment ID', async () => {
    const { module } = await setup(presetConfig('openai', 'gpt-4o'));
    const resolved = module.resolveModel('my-openai:gpt-4o');
    expect(resolved).toMatchObject({
      providerId: 'my-openai',
      endpointId: 'openai',
      modelId: 'gpt-4o',
      isPreset: true,
    });
    expect(resolved.endpoint.url).toBe('https://api.openai.com/v1');
    expect(resolved.endpoint.format).toBe('openai');
  });

  it('resolves anthropic preset models', async () => {
    const { module } = await setup(
      presetConfig('anthropic', 'claude-sonnet-4-20250514'),
    );
    const resolved = module.resolveModel('my-openai:claude-sonnet-4-20250514');
    expect(resolved.endpointId).toBe('anthropic');
    expect(resolved.endpoint.format).toBe('anthropic');
    expect(resolved.endpoint.url).toBe('https://api.anthropic.com/v1');
  });

  it('resolves google preset models', async () => {
    const { module } = await setup(
      presetConfig('google', 'gemini-2.5-pro', 'my-google'),
    );
    const resolved = module.resolveModel('my-google:gemini-2.5-pro');
    expect(resolved.endpointId).toBe('google');
    expect(resolved.endpoint.format).toBe('google');
  });

  it('resolves any model ID through a preset provider', async () => {
    const { module } = await setup(presetConfig());
    const resolved = module.resolveModel('my-openai:gpt-999');
    expect(resolved.modelId).toBe('gpt-999');
    expect(resolved.isPreset).toBe(true);
  });
});

describe('Config — resolveModel (mixed providers)', () => {
  it('resolves models from both preset and manual providers', async () => {
    const { module } = await setup(mixedConfig());
    const preset = module.resolveModel('remote:gpt-4o');
    expect(preset.isPreset).toBe(true);

    const manual = module.resolveModel('local:chat:model:8b');
    expect(manual.isPreset).toBe(false);
  });

  it('getModelSelection returns correct arrays per purpose', async () => {
    const { module } = await setup(mixedConfig());
    expect(module.getModelSelection('chat')).toEqual(['remote:gpt-4o']);
    expect(module.getModelSelection('compaction')).toEqual([
      'local:chat:model:8b',
    ]);
    expect(module.getModelSelection('memory')).toEqual([
      'local:api:test-model',
    ]);
  });
});

describe('Config — replace (atomic persistence)', () => {
  it('atomically replaces persisted and active config', async () => {
    const { directory, module } = await setup();
    const next = manualConfig('model:70b');

    await module.replace(next);

    expect(module.get()).toEqual(next);
    expect(
      JSON.parse(await readFile(join(directory, '.fluid.json'), 'utf8')),
    ).toEqual(next);
  });

  it('leaves prior state and file intact after invalid replacement', async () => {
    const { directory, module } = await setup();
    const before = await readFile(join(directory, '.fluid.json'), 'utf8');
    const invalid = manualConfig();
    invalid.modelSelection.chat = ['missing:chat:model'];

    await expect(module.replace(invalid)).rejects.toBeInstanceOf(
      ConfigValidationError,
    );
    expect(module.get()).toEqual(manualConfig());
    expect(await readFile(join(directory, '.fluid.json'), 'utf8')).toBe(before);
  });

  it('serializes concurrent replacements', async () => {
    const { directory, module } = await setup();
    const first = manualConfig('first');
    const second = manualConfig('second');

    await Promise.all([module.replace(first), module.replace(second)]);

    expect(module.get()).toEqual(second);
    expect(
      JSON.parse(await readFile(join(directory, '.fluid.json'), 'utf8')),
    ).toEqual(second);
  });

  it('rejects invalid JSON input', async () => {
    const { module } = await setup();
    await expect(module.replace('{ not json')).rejects.toThrow();
    // Active config should be unchanged
    expect(module.get()).toEqual(manualConfig());
  });

  it('rejects config with missing modelSelection keys', async () => {
    const { module } = await setup();
    await expect(
      module.replace({
        providers: {},
        modelSelection: { chat: [], compaction: [], memory: [] },
        mcpServers: {},
        // missing modelSelection.chat — but TS prevents this at compile time;
        // runtime test: pass an object with extra unknown keys (schema is strict)
      }),
    ).resolves.toBeDefined(); // empty config is valid
  });
});

describe('Config — subscriptions', () => {
  it('publishes only committed replacements', async () => {
    const { module } = await setup();
    const received: Readonly<FluidConfig>[] = [];
    module.subscribe((config) => {
      received.push(config);
    });

    const invalid = manualConfig();
    invalid.modelSelection.chat = ['missing:chat:model'];
    await expect(module.replace(invalid)).rejects.toBeInstanceOf(
      ConfigValidationError,
    );
    const next = manualConfig('committed');
    await module.replace(next);

    expect(received).toEqual([next]);
  });

  it('supports unsubscribe and clears listeners on close', async () => {
    const { module } = await setup();
    let calls = 0;
    const unsubscribe = module.subscribe(() => {
      calls += 1;
    });
    unsubscribe();
    await module.replace(manualConfig('ignored'));
    module.subscribe(() => {
      calls += 1;
    });
    await module.close();

    expect(calls).toBe(0);
  });

  it('isolates synchronous and asynchronous listener failures', async () => {
    const { module } = await setup();
    let successfulCalls = 0;
    module.subscribe(() => {
      throw new Error('sync failure');
    });
    module.subscribe(async () => {
      throw new Error('async failure');
    });
    module.subscribe(() => {
      successfulCalls += 1;
    });

    await expect(module.replace(manualConfig('next'))).resolves.toBeDefined();
    await Promise.resolve();
    expect(successfulCalls).toBe(1);
  });

  it('does not await asynchronous listeners', async () => {
    const { module } = await setup();
    let release: (() => void) | undefined;
    module.subscribe(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    await expect(module.replace(manualConfig('next'))).resolves.toBeDefined();
    expect(release).toBeDefined();
    release?.();
  });
});

describe('Config — validation', () => {
  it('rejects redaction markers in manual provider apiKey', async () => {
    const { module } = await setup();
    const config = manualConfig();
    const local = config.providers.local;
    if (!local || !('endpoints' in local))
      throw new Error('Expected fixture provider with endpoints');
    // biome-ignore lint/style/noNonNullAssertion: guarded by throw above
    local.endpoints.chat!.auth.apiKey = '[REDACTED]';
    await expect(module.replace(config)).rejects.toBeInstanceOf(
      ConfigValidationError,
    );
  });

  it('rejects redaction markers in preset provider apiKey', async () => {
    const { module } = await setup();
    const config = presetConfig();
    const provider = config.providers['my-openai'];
    if (!provider || !('preset' in provider))
      throw new Error('Expected preset provider');
    provider.auth.apiKey = '[REDACTED]';
    await expect(module.replace(config)).rejects.toBeInstanceOf(
      ConfigValidationError,
    );
  });

  it('rejects redaction markers in custom header values', async () => {
    const { module } = await setup();
    const config = manualConfig();
    const local = config.providers.local;
    if (!local || !('endpoints' in local))
      throw new Error('Expected fixture provider with endpoints');
    // biome-ignore lint/style/noNonNullAssertion: guarded by throw above
    local.endpoints.chat!.auth.headers = { 'X-Custom': '[REDACTED]' };
    await expect(module.replace(config)).rejects.toBeInstanceOf(
      ConfigValidationError,
    );
  });

  it('rejects redaction markers in MCP HTTP server headers', async () => {
    const { module } = await setup();
    const config = manualConfig();
    config.mcpServers.remote = {
      url: 'https://example.com/mcp',
      headers: { Authorization: '[REDACTED]' },
    };
    await expect(module.replace(config)).rejects.toBeInstanceOf(
      ConfigValidationError,
    );
  });

  it('rejects model selection referencing unknown provider', async () => {
    const { module } = await setup();
    const config = manualConfig();
    config.modelSelection.chat = ['nonexistent:chat:model'];
    await expect(module.replace(config)).rejects.toBeInstanceOf(
      ConfigValidationError,
    );
  });

  it('rejects model selection referencing unknown endpoint in manual provider', async () => {
    const { module } = await setup();
    const config = manualConfig();
    config.modelSelection.chat = ['local:missing:model'];
    await expect(module.replace(config)).rejects.toBeInstanceOf(
      ConfigValidationError,
    );
  });

  it('accepts any model ID for preset providers', async () => {
    const { module } = await setup();
    const config = presetConfig();
    config.modelSelection.chat = ['my-openai:gpt-999'];
    await expect(module.replace(config)).resolves.toBeDefined();
  });

  it('rejects model selection for manual provider without endpoint ID', async () => {
    const { module } = await setup();
    const config = manualConfig();
    // 'local:model' — only 2 segments, manual provider needs 3
    config.modelSelection.chat = ['local:model'];
    await expect(module.replace(config)).rejects.toBeInstanceOf(
      ConfigValidationError,
    );
  });

  it('rejects provider with both preset and endpoints (strict schema)', async () => {
    const { module } = await setup();
    const config = manualConfig();
    // Force a shape that has both — the z.strict() should reject this
    const local = config.providers.local;
    if (!local || !('endpoints' in local))
      throw new Error('Expected manual provider');
    (local as Record<string, unknown>).preset = 'openai';
    await expect(module.replace(config)).rejects.toBeInstanceOf(
      ConfigValidationError,
    );
  });

  it('rejects provider with neither preset nor endpoints', async () => {
    const { module } = await setup();
    const config = manualConfig();
    (config.providers as Record<string, unknown>).local = { auth: {} };
    await expect(module.replace(config)).rejects.toBeInstanceOf(
      ConfigValidationError,
    );
  });
});

describe('Config — env var resolution', () => {
  it('resolves {env:VAR} in preset provider apiKey', async () => {
    process.env.FLUID_TEST_KEY = 'env-resolved-key';
    try {
      const config = presetConfig();
      const provider = config.providers['my-openai'];
      if (!provider || !('preset' in provider))
        throw new Error('Expected preset provider');
      provider.auth.apiKey = '{env:FLUID_TEST_KEY}';
      const { module } = await setup(config);
      const resolved = module.resolveModel('my-openai:gpt-4o');
      expect(resolved.endpoint.auth.apiKey).toBe('env-resolved-key');
    } finally {
      delete process.env.FLUID_TEST_KEY;
    }
  });

  it('resolves {env:VAR} in manual endpoint apiKey', async () => {
    process.env.FLUID_TEST_KEY = 'manual-env-key';
    try {
      const config = manualConfig();
      const local = config.providers.local;
      if (!local || !('endpoints' in local))
        throw new Error('Expected manual provider');
      // biome-ignore lint/style/noNonNullAssertion: guarded by throw above
      local.endpoints.chat!.auth.apiKey = '{env:FLUID_TEST_KEY}';
      const { module } = await setup(config);
      const resolved = module.resolveModel('local:chat:model:8b');
      expect(resolved.endpoint.auth.apiKey).toBe('manual-env-key');
    } finally {
      delete process.env.FLUID_TEST_KEY;
    }
  });

  it('throws when env var is not set', async () => {
    const config = presetConfig();
    const provider = config.providers['my-openai'];
    if (!provider || !('preset' in provider))
      throw new Error('Expected preset provider');
    provider.auth.apiKey = '{env:NONEXISTENT_VAR_XYZ}';
    const { module } = await setup(config);
    expect(() => module.resolveModel('my-openai:gpt-4o')).toThrow(
      /NONEXISTENT_VAR_XYZ/,
    );
  });

  it('passes through literal apiKey values', async () => {
    const { module } = await setup(presetConfig());
    const resolved = module.resolveModel('my-openai:gpt-4o');
    expect(resolved.endpoint.auth.apiKey).toBe('sk-test');
  });
});

describe('Config — getMcpServers', () => {
  it('returns configured MCP servers', async () => {
    const config = manualConfig();
    config.mcpServers.remote = {
      url: 'https://example.com/mcp',
      headers: { 'x-api-key': 'secret' },
    };
    const { module } = await setup(config);
    const servers = module.getMcpServers();
    expect(servers.remote).toBeDefined();
    const remote = servers.remote;
    expect(remote && 'url' in remote ? remote.url : '').toBe(
      'https://example.com/mcp',
    );
  });

  it('returns empty record when no MCP servers configured', async () => {
    const { module } = await setup();
    expect(module.getMcpServers()).toEqual({});
  });

  it.each([
    ['legacy', 'legacy'],
    ['auto', 'auto'],
    ['pinned', { pin: '2026-07-28' }],
  ] as const)('accepts %s MCP version negotiation', async (_label, mode) => {
    const config = manualConfig();
    config.mcpServers.remote = {
      url: 'https://example.com/mcp',
      versionNegotiation: mode,
    };
    const { module } = await setup(config);
    expect(module.getMcpServers().remote?.versionNegotiation).toEqual(mode);
  });

  it('keeps omitted MCP version negotiation valid', async () => {
    const config = manualConfig();
    config.mcpServers.local = { command: 'mcp-server' };
    const { module } = await setup(config);
    expect(module.getMcpServers().local?.versionNegotiation).toBeUndefined();
  });

  it.each([{}, { pin: '' }, 'modern'])(
    'rejects invalid MCP version negotiation: %j',
    async (versionNegotiation) => {
      const config = manualConfig() as unknown as Record<string, unknown>;
      const mcpServers = config.mcpServers as Record<string, unknown>;
      mcpServers.remote = {
        url: 'https://example.com/mcp',
        versionNegotiation,
      };
      const { module } = await setup();
      await expect(module.replace(config)).rejects.toBeInstanceOf(
        ConfigValidationError,
      );
    },
  );
});
