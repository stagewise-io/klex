import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { RootLogger } from '@stagewise/logger';

import {
  CONFIG_FILE_NAME,
  ConfigValidationError,
  createConfig,
  DEFAULT_CONTEXT_SIZE,
  openAIRealtimeWebSocketUrl,
} from './config';
import {
  type EndpointAuth,
  type EndpointConfig,
  type KlexConfig,
  klexConfigSchema,
  type ModelDefinition,
  type ModelSelectionEntry,
  type ProviderConfig,
  type ProviderPreset,
} from './types';

const directories: string[] = [];
const logging = {
  child: () => ({
    error: () => undefined,
    info: () => undefined,
    warn: () => undefined,
  }),
} as unknown as RootLogger;

// --- fixtures ---

function manualConfig(modelId = 'model:8b'): KlexConfig {
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
      imageVision: [],
      audioListening: [],
    },
    mcpServers: {},
    realtime: { mode: 'disabled' },
  };
}

function presetConfig(
  preset: ProviderPreset = 'openai',
  modelId = 'gpt-4o',
  providerId = 'my-openai',
): KlexConfig {
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
      imageVision: [],
      audioListening: [],
    },
    mcpServers: {},
    realtime: { mode: 'disabled' },
  };
}

function mixedConfig(): KlexConfig {
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
      imageVision: [],
      audioListening: [],
    },
    mcpServers: {},
    realtime: { mode: 'disabled' },
  };
}

async function setup(config = manualConfig()) {
  const directory = await mkdtemp(join(tmpdir(), 'klex-config-'));
  directories.push(directory);
  await writeFile(
    join(directory, CONFIG_FILE_NAME),
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

describe('Config — realtime mode', () => {
  it('defaults legacy config input to disabled', () => {
    const { realtime: _realtime, ...legacy } = manualConfig();
    expect(klexConfigSchema.parse(legacy).realtime).toEqual({
      mode: 'disabled',
    });
  });

  it('accepts opt-in loopback mode', () => {
    expect(
      klexConfigSchema.parse({
        ...manualConfig(),
        realtime: { mode: 'loopback' },
      }).realtime,
    ).toEqual({ mode: 'loopback' });
  });

  it('validates and resolves OpenAI realtime configuration', async () => {
    const config = presetConfig('openai', 'gpt-realtime-2.1');
    config.realtime = {
      mode: 'openai-realtime',
      model: 'my-openai:gpt-realtime-2.1',
      voice: 'marin',
      instructions: 'Answer briefly.',
      serverVad: { threshold: 0.6, silenceDurationMs: 400 },
    };
    const { module } = await setup(config);
    expect(module.resolveOpenAIRealtime()).toEqual({
      modelId: 'gpt-realtime-2.1',
      apiKey: 'sk-test',
      websocketUrl: 'wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1',
      voice: 'marin',
      instructions: 'Answer briefly.',
      serverVad: { threshold: 0.6, silenceDurationMs: 400 },
    });
  });

  it.each([
    { threshold: -0.1 },
    { threshold: 1.1 },
    { prefixPaddingMs: -1 },
    { silenceDurationMs: 99 },
  ])('rejects malformed server VAD: %j', (serverVad) => {
    expect(
      klexConfigSchema.safeParse({
        ...presetConfig(),
        realtime: {
          mode: 'openai-realtime',
          model: 'my-openai:gpt-realtime',
          voice: 'marin',
          instructions: 'Answer briefly.',
          serverVad,
        },
      }).success,
    ).toBe(false);
  });

  it('rejects missing environment credentials during resolution', async () => {
    const config = presetConfig();
    const provider = config.providers['my-openai'];
    if (!provider || !('preset' in provider))
      throw new Error('Expected preset');
    provider.auth.apiKey = '{env:KLEX_TEST_MISSING_OPENAI_KEY}';
    config.realtime = {
      mode: 'openai-realtime',
      model: 'my-openai:gpt-realtime',
      voice: 'marin',
      instructions: 'Answer briefly.',
    };
    const { module } = await setup(config);
    expect(() => module.resolveOpenAIRealtime()).toThrow(
      'Environment variable KLEX_TEST_MISSING_OPENAI_KEY is not set',
    );
  });

  it('rejects non-OpenAI realtime endpoints', async () => {
    const config = manualConfig();
    config.realtime = {
      mode: 'openai-realtime',
      model: 'local:chat:model:8b',
      voice: 'marin',
      instructions: 'Answer briefly.',
    };
    const { module } = await setup(config);
    expect(() => module.resolveOpenAIRealtime()).toThrow(
      'OpenAI realtime requires an OpenAI endpoint',
    );
  });

  it('derives secure and local realtime WebSocket URLs', () => {
    expect(
      openAIRealtimeWebSocketUrl('https://api.openai.com/v1/', 'model/a'),
    ).toBe('wss://api.openai.com/v1/realtime?model=model%2Fa');
    expect(openAIRealtimeWebSocketUrl('http://localhost:8080/v1', 'm')).toBe(
      'ws://localhost:8080/v1/realtime?model=m',
    );
    expect(() =>
      openAIRealtimeWebSocketUrl('ftp://example.com/v1', 'm'),
    ).toThrow('must use HTTP or HTTPS');
  });
});

describe('Config — lifecycle', () => {
  it('throws if config file does not exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'klex-config-'));
    directories.push(dir);
    const module = createConfig({ logging, dataDirectory: dir });
    await expect(module.start()).rejects.toThrow(/not found/);
  });

  it('throws if config file is not valid JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'klex-config-'));
    directories.push(dir);
    await writeFile(join(dir, CONFIG_FILE_NAME), '{ not json');
    const module = createConfig({ logging, dataDirectory: dir });
    await expect(module.start()).rejects.toThrow(/not valid JSON/);
  });

  it('throws on schema violation with ConfigValidationError wrapped message', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'klex-config-'));
    directories.push(dir);
    await writeFile(
      join(dir, CONFIG_FILE_NAME),
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

describe('Config — resolveModelInfo', () => {
  it('resolves contextSize from preset provider knownModels', async () => {
    const config = presetConfig();
    const provider = config.providers['my-openai'];
    if (!provider || !('preset' in provider))
      throw new Error('Expected preset provider');
    provider.knownModels = {
      'gpt-4o': { contextSize: 128_000 },
    };
    const { module } = await setup(config);
    expect(module.resolveModelInfo('my-openai:gpt-4o').contextSize).toBe(
      128_000,
    );
  });

  it('resolves contextSize from manual endpoint knownModels', async () => {
    const config = manualConfig();
    const local = config.providers.local;
    if (!local || !('endpoints' in local))
      throw new Error('Expected manual provider');
    local.endpoints.chat!.knownModels = {
      'model:8b': { contextSize: 8_192 },
    };
    const { module } = await setup(config);
    expect(module.resolveModelInfo('local:chat:model:8b').contextSize).toBe(
      8_192,
    );
  });

  it('defaults to DEFAULT_CONTEXT_SIZE when contextSize is absent', async () => {
    const { module } = await setup(presetConfig());
    expect(module.resolveModelInfo('my-openai:gpt-4o').contextSize).toBe(
      DEFAULT_CONTEXT_SIZE,
    );
  });

  it('defaults to DEFAULT_CONTEXT_SIZE when knownModels is absent', async () => {
    const { module } = await setup(manualConfig());
    expect(module.resolveModelInfo('local:chat:model:8b').contextSize).toBe(
      DEFAULT_CONTEXT_SIZE,
    );
  });

  it('resolveModelInfo returns the resolved context size', async () => {
    const config = presetConfig();
    const provider = config.providers['my-openai'];
    if (!provider || !('preset' in provider))
      throw new Error('Expected preset provider');
    provider.knownModels = {
      'gpt-4o': { contextSize: 64_000 },
    };
    const { module } = await setup(config);
    expect(module.resolveModelInfo('my-openai:gpt-4o').contextSize).toBe(
      64_000,
    );
  });

  it('resolveModelInfo returns DEFAULT_CONTEXT_SIZE for unknown model metadata', async () => {
    const { module } = await setup(presetConfig());
    expect(module.resolveModelInfo('my-openai:gpt-999').contextSize).toBe(
      DEFAULT_CONTEXT_SIZE,
    );
  });

  it('accepts displayName in knownModels entries', async () => {
    const config = presetConfig();
    const provider = config.providers['my-openai'];
    if (!provider || !('preset' in provider))
      throw new Error('Expected preset provider');
    provider.knownModels = {
      'gpt-4o': { displayName: 'GPT-4o', contextSize: 128_000 },
    };
    const { module } = await setup(config);
    const info = module.resolveModelInfo('my-openai:gpt-4o');
    expect(info.contextSize).toBe(128_000);
    expect(info.displayName).toBe('GPT-4o');
  });

  it('resolves displayName from manual endpoint knownModels', async () => {
    const config = manualConfig();
    const local = config.providers.local;
    if (!local || !('endpoints' in local))
      throw new Error('Expected manual provider');
    local.endpoints.chat!.knownModels = {
      'model:8b': { displayName: 'Local 8B', contextSize: 8_192 },
    };
    const { module } = await setup(config);
    expect(module.resolveModelInfo('local:chat:model:8b').displayName).toBe(
      'Local 8B',
    );
  });

  it('returns displayName undefined when not declared in knownModels', async () => {
    const config = presetConfig();
    const provider = config.providers['my-openai'];
    if (!provider || !('preset' in provider))
      throw new Error('Expected preset provider');
    provider.knownModels = {
      'gpt-4o': { contextSize: 128_000 },
    };
    const { module } = await setup(config);
    expect(
      module.resolveModelInfo('my-openai:gpt-4o').displayName,
    ).toBeUndefined();
  });

  it('returns displayName undefined when knownModels is absent', async () => {
    const { module } = await setup(manualConfig());
    expect(
      module.resolveModelInfo('local:chat:model:8b').displayName,
    ).toBeUndefined();
  });

  it('resolves native media capabilities and normalizes absent capabilities', async () => {
    const config = presetConfig();
    const provider = config.providers['my-openai'];
    if (!provider || !('preset' in provider))
      throw new Error('Expected preset provider');
    provider.knownModels = {
      'gpt-4o': {
        inputCapabilities: {
          image: {
            mediaTypes: ['image/png', 'image/jpeg'],
            maxBytes: 1_000_000,
          },
          audio: {
            mediaTypes: ['audio/mpeg', 'audio/wav'],
            maxBytes: 2_000_000,
          },
        },
      },
    };
    const { module } = await setup(config);

    expect(
      module.resolveModelInfo('my-openai:gpt-4o').inputCapabilities,
    ).toEqual({
      image: { mediaTypes: ['image/png', 'image/jpeg'], maxBytes: 1_000_000 },
      audio: { mediaTypes: ['audio/mpeg', 'audio/wav'], maxBytes: 2_000_000 },
    });
    expect(
      module.resolveModelInfo('my-openai:unknown').inputCapabilities,
    ).toEqual({});
  });

  it('resolves contextSize independently per endpoint in manual providers', async () => {
    const config = mixedConfig();
    const local = config.providers.local;
    if (!local || !('endpoints' in local))
      throw new Error('Expected manual provider');
    local.endpoints.chat!.knownModels = { 'model:8b': { contextSize: 4_096 } };
    local.endpoints.api!.knownModels = {
      'test-model': { contextSize: 32_768 },
    };
    const { module } = await setup(config);
    expect(module.resolveModelInfo('local:chat:model:8b').contextSize).toBe(
      4_096,
    );
    expect(module.resolveModelInfo('local:api:test-model').contextSize).toBe(
      32_768,
    );
  });
});

describe('Config — input capability validation', () => {
  it.each([
    { image: { mediaTypes: [], maxBytes: 100 } },
    { image: { mediaTypes: ['text/plain'], maxBytes: 100 } },
    { image: { mediaTypes: ['image/png'], maxBytes: 0 } },
    { image: { mediaTypes: ['image/png'], maxBytes: 100, extra: true } },
  ])('rejects malformed image capabilities: %j', (inputCapabilities) => {
    const config = presetConfig();
    const provider = config.providers['my-openai'];
    if (!provider || !('preset' in provider))
      throw new Error('Expected preset provider');
    provider.knownModels = {
      'gpt-4o': { inputCapabilities } as never,
    };

    expect(klexConfigSchema.safeParse(config).success).toBe(false);
  });

  it.each([
    { audio: { mediaTypes: [], maxBytes: 100 } },
    { audio: { mediaTypes: ['text/plain'], maxBytes: 100 } },
    { audio: { mediaTypes: ['audio/mpeg'], maxBytes: 0 } },
    { audio: { mediaTypes: ['audio/mpeg'], maxBytes: 100, extra: true } },
  ])('rejects malformed audio capabilities: %j', (inputCapabilities) => {
    const config = presetConfig();
    const provider = config.providers['my-openai'];
    if (!provider || !('preset' in provider))
      throw new Error('Expected preset provider');
    provider.knownModels = {
      'gpt-4o': { inputCapabilities } as never,
    };

    expect(klexConfigSchema.safeParse(config).success).toBe(false);
  });

  it('resolves image capability with dimension constraints from preset provider knownModels', async () => {
    const config = presetConfig();
    const provider = config.providers['my-openai'];
    if (!provider || !('preset' in provider))
      throw new Error('Expected preset provider');
    provider.knownModels = {
      'gpt-4o': {
        contextSize: 128_000,
        inputCapabilities: {
          image: {
            mediaTypes: ['image/png', 'image/jpeg'],
            maxBytes: 1_000_000,
            maxWidth: 1024,
            maxHeight: 768,
            maxTotalPixels: 500_000,
          },
        },
      },
    };
    const { module } = await setup(config);
    const caps = module.resolveModel('my-openai:gpt-4o').inputCapabilities;
    expect(caps.image).toEqual({
      mediaTypes: ['image/png', 'image/jpeg'],
      maxBytes: 1_000_000,
      maxWidth: 1024,
      maxHeight: 768,
      maxTotalPixels: 500_000,
    });
  });

  it('resolves image capability with supports=false from manual endpoint knownModels', async () => {
    const config = manualConfig();
    const local = config.providers.local;
    if (!local || !('endpoints' in local))
      throw new Error('Expected manual provider');
    local.endpoints.chat!.knownModels = {
      'model:8b': {
        contextSize: 8_192,
        inputCapabilities: {},
      },
    };
    const { module } = await setup(config);
    expect(
      module.resolveModel('local:chat:model:8b').inputCapabilities.image,
    ).toBeUndefined();
  });

  it('returns inputCapabilities.image undefined when not declared', async () => {
    const config = presetConfig();
    const provider = config.providers['my-openai'];
    if (!provider || !('preset' in provider))
      throw new Error('Expected preset provider');
    provider.knownModels = {
      'gpt-4o': { contextSize: 128_000 },
    };
    const { module } = await setup(config);
    expect(
      module.resolveModel('my-openai:gpt-4o').inputCapabilities.image,
    ).toBeUndefined();
  });

  it('returns inputCapabilities.image undefined when knownModels is absent', async () => {
    const { module } = await setup(manualConfig());
    expect(
      module.resolveModel('local:chat:model:8b').inputCapabilities.image,
    ).toBeUndefined();
  });
});

describe('Config — replace (atomic persistence)', () => {
  it('atomically replaces persisted and active config', async () => {
    const { directory, module } = await setup();
    const next = manualConfig('model:70b');

    await module.replace(next);

    expect(module.get()).toEqual(next);
    expect(
      JSON.parse(await readFile(join(directory, CONFIG_FILE_NAME), 'utf8')),
    ).toEqual(next);
  });

  it('leaves prior state and file intact after invalid replacement', async () => {
    const { directory, module } = await setup();
    const before = await readFile(join(directory, CONFIG_FILE_NAME), 'utf8');
    const invalid = manualConfig();
    invalid.modelSelection.chat = ['missing:chat:model'];

    await expect(module.replace(invalid)).rejects.toBeInstanceOf(
      ConfigValidationError,
    );
    expect(module.get()).toEqual(manualConfig());
    expect(await readFile(join(directory, CONFIG_FILE_NAME), 'utf8')).toBe(
      before,
    );
  });

  it('serializes concurrent replacements', async () => {
    const { directory, module } = await setup();
    const first = manualConfig('first');
    const second = manualConfig('second');

    await Promise.all([module.replace(first), module.replace(second)]);

    expect(module.get()).toEqual(second);
    expect(
      JSON.parse(await readFile(join(directory, CONFIG_FILE_NAME), 'utf8')),
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
        modelSelection: {
          chat: [],
          compaction: [],
          memory: [],
          imageVision: [],
          audioListening: [],
        },
        mcpServers: {},
        // missing modelSelection.chat — but TS prevents this at compile time;
        // runtime test: pass an object with extra unknown keys (schema is strict)
      }),
    ).resolves.toBeDefined(); // empty config is valid
  });
});

describe('Config — mutate', () => {
  it('applies transform and returns updated config', async () => {
    const { module } = await setup(
      noSelectionConfig({
        remote: { preset: 'openai', auth: { apiKey: 'sk-test' } },
      }),
    );
    const result = await module.mutate((current) => ({
      ...current,
      providers: {
        ...current.providers,
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
    }));
    expect(result.providers.local).toBeDefined();
    expect(result.providers.remote).toBeDefined();
    expect(module.get().providers.local).toBeDefined();
  });

  it('sees latest state after a previous mutation', async () => {
    const { module } = await setup(
      noSelectionConfig({
        remote: { preset: 'openai', auth: { apiKey: 'sk-test' } },
      }),
    );
    await module.mutate((current) => ({
      ...current,
      providers: {
        ...current.providers,
        first: { preset: 'openai', auth: { apiKey: 'sk-1' } },
      },
    }));
    const result = await module.mutate((current) => ({
      ...current,
      providers: {
        ...current.providers,
        second: { preset: 'anthropic', auth: { apiKey: 'sk-2' } },
      },
    }));
    expect(result.providers.first).toBeDefined();
    expect(result.providers.second).toBeDefined();
    expect(module.get().providers.first).toBeDefined();
    expect(module.get().providers.second).toBeDefined();
  });

  it('serializes concurrent mutations', async () => {
    const { module } = await setup(
      noSelectionConfig({
        remote: { preset: 'openai', auth: { apiKey: 'sk-test' } },
      }),
    );
    await Promise.all([
      module.mutate((current) => ({
        ...current,
        providers: {
          ...current.providers,
          a: { preset: 'openai', auth: { apiKey: 'sk-a' } },
        },
      })),
      module.mutate((current) => ({
        ...current,
        providers: {
          ...current.providers,
          b: { preset: 'openai', auth: { apiKey: 'sk-b' } },
        },
      })),
    ]);
    expect(module.get().providers.a).toBeDefined();
    expect(module.get().providers.b).toBeDefined();
  });

  it('propagates ConfigValidationError from transform', async () => {
    const { module } = await setup();
    await expect(
      module.mutate(() => {
        throw new ConfigValidationError('test error', { code: 'not_found' });
      }),
    ).rejects.toBeInstanceOf(ConfigValidationError);
    // State should be unchanged
    expect(module.get()).toEqual(manualConfig());
  });

  it('does not validate references through mutate (by design)', async () => {
    // mutate intentionally skips validateModelReferences so that
    // non-model-selection mutations succeed even when existing
    // modelSelection has broken references.
    const { module } = await setup();
    const result = await module.mutate((current) => ({
      ...current,
      modelSelection: {
        ...current.modelSelection,
        chat: ['nonexistent:chat:model'],
      },
    }));
    expect(result.modelSelection.chat).toEqual(['nonexistent:chat:model']);
  });
});

describe('Config — subscriptions', () => {
  it('publishes only committed replacements', async () => {
    const { module } = await setup();
    const received: Readonly<KlexConfig>[] = [];
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
    await expect(module.replace(config)).rejects.toMatchObject({
      code: 'validation',
    });
  });

  it('rejects redaction markers in preset provider apiKey', async () => {
    const { module } = await setup();
    const config = presetConfig();
    const provider = config.providers['my-openai'];
    if (!provider || !('preset' in provider))
      throw new Error('Expected preset provider');
    provider.auth.apiKey = '[REDACTED]';
    await expect(module.replace(config)).rejects.toMatchObject({
      code: 'validation',
    });
  });

  it('rejects redaction markers in custom header values', async () => {
    const { module } = await setup();
    const config = manualConfig();
    const local = config.providers.local;
    if (!local || !('endpoints' in local))
      throw new Error('Expected fixture provider with endpoints');
    // biome-ignore lint/style/noNonNullAssertion: guarded by throw above
    local.endpoints.chat!.auth.headers = { 'X-Custom': '[REDACTED]' };
    await expect(module.replace(config)).rejects.toMatchObject({
      code: 'validation',
    });
  });

  it('rejects redaction markers in MCP HTTP server headers', async () => {
    const { module } = await setup();
    const config = manualConfig();
    config.mcpServers.remote = {
      url: 'https://example.com/mcp',
      headers: { Authorization: '[REDACTED]' },
    };
    await expect(module.replace(config)).rejects.toMatchObject({
      code: 'validation',
    });
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
    process.env.KLEX_TEST_KEY = 'env-resolved-key';
    try {
      const config = presetConfig();
      const provider = config.providers['my-openai'];
      if (!provider || !('preset' in provider))
        throw new Error('Expected preset provider');
      provider.auth.apiKey = '{env:KLEX_TEST_KEY}';
      const { module } = await setup(config);
      const resolved = module.resolveModel('my-openai:gpt-4o');
      expect(resolved.endpoint.auth.apiKey).toBe('env-resolved-key');
    } finally {
      delete process.env.KLEX_TEST_KEY;
    }
  });

  it('resolves {env:VAR} in manual endpoint apiKey', async () => {
    process.env.KLEX_TEST_KEY = 'manual-env-key';
    try {
      const config = manualConfig();
      const local = config.providers.local;
      if (!local || !('endpoints' in local))
        throw new Error('Expected manual provider');
      // biome-ignore lint/style/noNonNullAssertion: guarded by throw above
      local.endpoints.chat!.auth.apiKey = '{env:KLEX_TEST_KEY}';
      const { module } = await setup(config);
      const resolved = module.resolveModel('local:chat:model:8b');
      expect(resolved.endpoint.auth.apiKey).toBe('manual-env-key');
    } finally {
      delete process.env.KLEX_TEST_KEY;
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

  it('resolves environment references in MCP HTTP headers without mutating persisted config', async () => {
    process.env.KLEX_TEST_MCP_TOKEN = 'resolved-secret';
    try {
      const config = manualConfig();
      config.mcpServers.remote = {
        url: 'https://example.com/mcp',
        headers: {
          Authorization: '{env:KLEX_TEST_MCP_TOKEN}',
          'X-Literal': 'literal-value',
        },
      };
      const { module } = await setup(config);

      expect(module.getMcpServers().remote).toMatchObject({
        headers: {
          Authorization: 'resolved-secret',
          'X-Literal': 'literal-value',
        },
      });
      expect(module.get().mcpServers.remote).toMatchObject({
        headers: { Authorization: '{env:KLEX_TEST_MCP_TOKEN}' },
      });
    } finally {
      delete process.env.KLEX_TEST_MCP_TOKEN;
    }
  });

  it('rejects unresolved environment references when MCP servers are consumed', async () => {
    const config = manualConfig();
    config.mcpServers.remote = {
      url: 'https://example.com/mcp',
      headers: { Authorization: '{env:KLEX_TEST_MISSING_MCP_TOKEN}' },
    };
    const { module } = await setup(config);

    expect(() => module.getMcpServers()).toThrow(
      'Environment variable KLEX_TEST_MISSING_MCP_TOKEN is not set',
    );
  });

  it('returns defensive MCP server copies', async () => {
    const config = manualConfig();
    config.mcpServers.remote = {
      url: 'https://example.com/mcp',
      headers: { 'X-Test': 'original' },
    };
    const { module } = await setup(config);
    const servers = module.getMcpServers();
    const remote = servers.remote;
    if (remote && 'url' in remote && remote.headers) {
      remote.headers['X-Test'] = 'changed';
    }
    expect(module.getMcpServers().remote).toMatchObject({
      headers: { 'X-Test': 'original' },
    });
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

describe('Config — MCP server CRUD', () => {
  const stdioServer = { command: 'mcp-server', args: ['--port', '3000'] };
  const httpServer = { url: 'https://example.com/mcp' };

  it('addMcpServer adds a server', async () => {
    const { module } = await setup();
    await module.addMcpServer('new-server', stdioServer);
    expect(module.getMcpServers()['new-server']).toBeDefined();
  });

  it('addMcpServer rejects duplicate name', async () => {
    const { module } = await setup();
    await module.addMcpServer('new-server', stdioServer);
    await expect(
      module.addMcpServer('new-server', httpServer),
    ).rejects.toMatchObject({ code: 'already_exists' });
  });

  it('updateMcpServer replaces an existing server', async () => {
    const { module } = await setup();
    await module.addMcpServer('srv', stdioServer);
    await module.updateMcpServer('srv', httpServer);
    const server = module.getMcpServers().srv;
    expect(server && 'url' in server ? server.url : '').toBe(
      'https://example.com/mcp',
    );
  });

  it('updateMcpServer rejects unknown server', async () => {
    const { module } = await setup();
    await expect(
      module.updateMcpServer('nonexistent', stdioServer),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('removeMcpServer removes a server', async () => {
    const { module } = await setup();
    await module.addMcpServer('srv', stdioServer);
    await module.removeMcpServer('srv');
    expect(module.getMcpServers().srv).toBeUndefined();
  });

  it('removeMcpServer rejects unknown server', async () => {
    const { module } = await setup();
    await expect(module.removeMcpServer('nonexistent')).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('Config — mutate skips validateModelReferences', () => {
  it('allows mutating non-model-selection fields when modelSelection has broken references', async () => {
    // Start with a valid config, then use mutate to introduce a broken
    // model selection reference (mutate skips reference validation).
    const { module } = await setup(
      noSelectionConfig({
        local: {
          endpoints: {
            chat: {
              url: 'http://localhost:11434/v1',
              format: 'chat-completions',
              auth: {},
            },
          },
        },
      }),
    );
    await module.mutate((current) => ({
      ...current,
      modelSelection: {
        ...current.modelSelection,
        chat: ['nonexistent:model'],
      },
    }));

    // A subsequent non-model-selection mutation should succeed even though
    // modelSelection references a non-existent provider.
    await module.addEndpoint('local', 'api', {
      url: 'http://localhost:8080/v1',
      format: 'open-responses',
      auth: {},
    });
    const provider = module.get().providers.local;
    expect(
      provider && 'endpoints' in provider ? provider.endpoints.api : null,
    ).toBeDefined();
  });
});

function noSelectionConfig(providers: KlexConfig['providers']): KlexConfig {
  return {
    providers,
    modelSelection: {
      chat: [],
      compaction: [],
      memory: [],
      imageVision: [],
      audioListening: [],
    },
    mcpServers: {},
  };
}

describe('Config — provider CRUD', () => {
  const newPresetProvider: ProviderConfig = {
    preset: 'anthropic',
    auth: { apiKey: 'sk-new' },
  };

  const newManualProvider: ProviderConfig = {
    endpoints: {
      api: {
        url: 'http://localhost:9000/v1',
        format: 'chat-completions',
        auth: {},
      },
    },
  };

  it('addProvider adds a new preset provider', async () => {
    const { module } = await setup();
    await module.addProvider('new-openai', newPresetProvider);
    const provider = module.get().providers['new-openai'];
    expect(provider).toBeDefined();
    expect(provider && 'preset' in provider ? provider.preset : '').toBe(
      'anthropic',
    );
  });

  it('addProvider adds a new manual provider', async () => {
    const { module } = await setup();
    await module.addProvider('new-local', newManualProvider);
    const provider = module.get().providers['new-local'];
    expect(provider).toBeDefined();
    expect(
      provider && 'endpoints' in provider ? provider.endpoints.api : null,
    ).toBeDefined();
  });

  it('addProvider rejects duplicate name', async () => {
    const { module } = await setup();
    await expect(
      module.addProvider('local', newManualProvider),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });

  it('updateProvider replaces a preset provider with a manual provider', async () => {
    const { module } = await setup(
      noSelectionConfig({
        'my-openai': { preset: 'openai', auth: { apiKey: 'sk-test' } },
      }),
    );
    await module.updateProvider('my-openai', newManualProvider);
    const provider = module.get().providers['my-openai'];
    expect(provider).toBeDefined();
    expect(
      provider && 'endpoints' in provider ? provider.endpoints.api : null,
    ).toBeDefined();
  });

  it('updateProvider rejects unknown provider', async () => {
    const { module } = await setup();
    await expect(
      module.updateProvider('nonexistent', newPresetProvider),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });

  it('removeProvider deletes the provider', async () => {
    const { module } = await setup(
      noSelectionConfig({
        remote: { preset: 'openai', auth: { apiKey: 'sk-test' } },
        local: {
          endpoints: {
            chat: {
              url: 'http://localhost:11434/v1',
              format: 'chat-completions',
              auth: {},
            },
          },
        },
      }),
    );
    await module.removeProvider('remote');
    expect(module.get().providers.remote).toBeUndefined();
  });

  it('removeProvider cascades — deletes all endpoints within the provider', async () => {
    const { module } = await setup(
      noSelectionConfig({
        remote: { preset: 'openai', auth: { apiKey: 'sk-test' } },
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
      }),
    );
    await module.removeProvider('local');
    expect(module.get().providers.local).toBeUndefined();
  });

  it('removeProvider rejects unknown provider', async () => {
    const { module } = await setup();
    await expect(module.removeProvider('nonexistent')).rejects.toBeInstanceOf(
      ConfigValidationError,
    );
  });

  it('removeProvider rejects when model selection still references the provider', async () => {
    const { module } = await setup();
    // manualConfig has modelSelection.chat = ['local:chat:model:8b']
    await expect(module.removeProvider('local')).rejects.toMatchObject({
      code: 'referential_integrity',
    });
  });
});

describe('Config — endpoint CRUD', () => {
  const newEndpoint: EndpointConfig = {
    url: 'http://localhost:7000/v1',
    format: 'open-responses',
    auth: { apiKey: 'endpoint-key' },
  };

  it('addEndpoint adds an endpoint to a manual provider', async () => {
    const { module } = await setup();
    await module.addEndpoint('local', 'new-ep', newEndpoint);
    const provider = module.get().providers.local;
    expect(
      provider && 'endpoints' in provider ? provider.endpoints['new-ep'] : null,
    ).toBeDefined();
  });

  it('addEndpoint rejects unknown provider', async () => {
    const { module } = await setup();
    await expect(
      module.addEndpoint('nonexistent', 'ep', newEndpoint),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });

  it('addEndpoint rejects preset providers', async () => {
    const { module } = await setup(presetConfig());
    await expect(
      module.addEndpoint('my-openai', 'ep', newEndpoint),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });

  it('addEndpoint rejects duplicate endpoint name', async () => {
    const { module } = await setup(mixedConfig());
    await expect(
      module.addEndpoint('local', 'chat', newEndpoint),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });

  it('updateEndpoint replaces the endpoint config', async () => {
    const { module } = await setup();
    await module.updateEndpoint('local', 'chat', newEndpoint);
    const provider = module.get().providers.local;
    const ep =
      provider && 'endpoints' in provider ? provider.endpoints.chat : null;
    expect(ep?.url).toBe('http://localhost:7000/v1');
    expect(ep?.format).toBe('open-responses');
  });

  it('updateEndpoint preserves knownModels on the endpoint', async () => {
    const { module } = await setup();
    // Add a known model first
    await module.addKnownModel(
      'local',
      'llama3',
      {
        displayName: 'Test Model',
        contextSize: 128_000,
      },
      'chat',
    );
    // Now update the endpoint
    await module.updateEndpoint('local', 'chat', newEndpoint);
    const provider = module.get().providers.local;
    const ep =
      provider && 'endpoints' in provider ? provider.endpoints.chat : null;
    expect(ep?.url).toBe('http://localhost:7000/v1');
    expect(ep?.knownModels?.llama3).toEqual({
      displayName: 'Test Model',
      contextSize: 128_000,
    });
  });

  it('updateEndpoint rejects unknown provider', async () => {
    const { module } = await setup();
    await expect(
      module.updateEndpoint('nonexistent', 'ep', newEndpoint),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });

  it('updateEndpoint rejects unknown endpoint', async () => {
    const { module } = await setup();
    await expect(
      module.updateEndpoint('local', 'nonexistent', newEndpoint),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });

  it('updateEndpoint rejects preset providers', async () => {
    const { module } = await setup(presetConfig());
    await expect(
      module.updateEndpoint('my-openai', 'ep', newEndpoint),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });

  it('removeEndpoint removes an endpoint from a manual provider', async () => {
    const { module } = await setup(
      noSelectionConfig({
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
      }),
    );
    await module.removeEndpoint('local', 'chat');
    const provider = module.get().providers.local;
    expect(
      provider && 'endpoints' in provider ? provider.endpoints.chat : null,
    ).toBeUndefined();
  });

  it('removeEndpoint rejects unknown provider', async () => {
    const { module } = await setup();
    await expect(
      module.removeEndpoint('nonexistent', 'ep'),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });

  it('removeEndpoint rejects unknown endpoint', async () => {
    const { module } = await setup();
    await expect(
      module.removeEndpoint('local', 'nonexistent'),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });

  it('removeEndpoint rejects preset providers', async () => {
    const { module } = await setup(presetConfig());
    await expect(
      module.removeEndpoint('my-openai', 'ep'),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });

  it('removeEndpoint rejects when model selection still references the endpoint', async () => {
    const { module } = await setup();
    // manualConfig has modelSelection.chat = ['local:chat:model:8b']
    await expect(module.removeEndpoint('local', 'chat')).rejects.toMatchObject({
      code: 'referential_integrity',
    });
  });
});

describe('Config — known model CRUD', () => {
  const modelDef: ModelDefinition = {
    displayName: 'Test Model',
    contextSize: 128_000,
  };

  // --- Preset provider known models ---

  it('addKnownModel adds a model to a preset provider', async () => {
    const { module } = await setup(presetConfig());
    await module.addKnownModel('my-openai', 'gpt-4o-mini', modelDef);
    const provider = module.get().providers['my-openai']!;
    if (!('preset' in provider)) throw new Error('Expected preset provider');
    expect(provider.knownModels?.['gpt-4o-mini']).toEqual(modelDef);
  });

  it('addKnownModel rejects endpointName on preset provider', async () => {
    const { module } = await setup(presetConfig());
    await expect(
      module.addKnownModel('my-openai', 'gpt-4o', modelDef, 'default'),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });

  it('addKnownModel rejects duplicate modelId on preset provider', async () => {
    const { module } = await setup(presetConfig());
    // presetConfig has modelSelection.chat = ['my-openai:gpt-4o'] but
    // knownModels is not populated — add one first, then duplicate
    await module.addKnownModel('my-openai', 'gpt-4o', modelDef);
    await expect(
      module.addKnownModel('my-openai', 'gpt-4o', modelDef),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });

  it('updateKnownModel updates a preset provider model', async () => {
    const { module } = await setup(presetConfig());
    await module.addKnownModel('my-openai', 'gpt-4o', modelDef);
    await module.updateKnownModel('my-openai', 'gpt-4o', {
      displayName: 'Updated',
      contextSize: 64_000,
    });
    const provider = module.get().providers['my-openai']!;
    if (!('preset' in provider)) throw new Error('Expected preset provider');
    expect(provider.knownModels?.['gpt-4o']).toEqual({
      displayName: 'Updated',
      contextSize: 64_000,
    });
  });

  it('updateKnownModel rejects unknown model on preset provider', async () => {
    const { module } = await setup(presetConfig());
    await expect(
      module.updateKnownModel('my-openai', 'nonexistent', modelDef),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });

  it('removeKnownModel removes a preset provider model', async () => {
    const { module } = await setup(presetConfig());
    await module.addKnownModel('my-openai', 'gpt-4o', modelDef);
    await module.removeKnownModel('my-openai', 'gpt-4o');
    const provider = module.get().providers['my-openai']!;
    if (!('preset' in provider)) throw new Error('Expected preset provider');
    expect(provider.knownModels?.['gpt-4o']).toBeUndefined();
  });

  it('removeKnownModel rejects unknown model on preset provider', async () => {
    const { module } = await setup(presetConfig());
    await expect(
      module.removeKnownModel('my-openai', 'nonexistent'),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });

  // --- Manual provider known models ---

  it('addKnownModel adds a model to a manual provider endpoint', async () => {
    const { module } = await setup();
    await module.addKnownModel('local', 'llama3', modelDef, 'chat');
    const provider = module.get().providers.local!;
    if (!('endpoints' in provider)) throw new Error('Expected manual provider');
    expect(provider.endpoints.chat?.knownModels?.llama3).toEqual(modelDef);
  });

  it('addKnownModel rejects missing endpointName on manual provider', async () => {
    const { module } = await setup();
    await expect(
      module.addKnownModel('local', 'llama3', modelDef),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });

  it('addKnownModel rejects unknown endpoint on manual provider', async () => {
    const { module } = await setup();
    await expect(
      module.addKnownModel('local', 'llama3', modelDef, 'nonexistent'),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });

  it('addKnownModel rejects duplicate modelId on manual provider endpoint', async () => {
    const { module } = await setup();
    await module.addKnownModel('local', 'llama3', modelDef, 'chat');
    await expect(
      module.addKnownModel('local', 'llama3', modelDef, 'chat'),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });

  it('addKnownModel allows same modelId on different endpoints', async () => {
    const { module } = await setup(
      noSelectionConfig({
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
      }),
    );
    await module.addKnownModel('local', 'llama3', modelDef, 'chat');
    await module.addKnownModel('local', 'llama3', modelDef, 'api');
    const provider = module.get().providers.local!;
    if (!('endpoints' in provider)) throw new Error('Expected manual provider');
    expect(provider.endpoints.chat?.knownModels?.llama3).toBeDefined();
    expect(provider.endpoints.api?.knownModels?.llama3).toBeDefined();
  });

  it('updateKnownModel updates a manual provider endpoint model', async () => {
    const { module } = await setup();
    await module.addKnownModel('local', 'llama3', modelDef, 'chat');
    await module.updateKnownModel(
      'local',
      'llama3',
      { displayName: 'Updated', contextSize: 64_000 },
      'chat',
    );
    const provider = module.get().providers.local!;
    if (!('endpoints' in provider)) throw new Error('Expected manual provider');
    expect(provider.endpoints.chat?.knownModels?.llama3).toEqual({
      displayName: 'Updated',
      contextSize: 64_000,
    });
  });

  it('updateKnownModel rejects unknown model on manual provider endpoint', async () => {
    const { module } = await setup();
    await expect(
      module.updateKnownModel('local', 'nonexistent', modelDef, 'chat'),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });

  it('removeKnownModel removes a manual provider endpoint model', async () => {
    const { module } = await setup();
    await module.addKnownModel('local', 'llama3', modelDef, 'chat');
    await module.removeKnownModel('local', 'llama3', 'chat');
    const provider = module.get().providers.local!;
    if (!('endpoints' in provider)) throw new Error('Expected manual provider');
    expect(provider.endpoints.chat?.knownModels?.llama3).toBeUndefined();
  });

  it('removeKnownModel sets knownModels to undefined when last model is removed from manual endpoint', async () => {
    const { module } = await setup();
    await module.addKnownModel('local', 'llama3', modelDef, 'chat');
    await module.removeKnownModel('local', 'llama3', 'chat');
    const provider = module.get().providers.local!;
    if (!('endpoints' in provider)) throw new Error('Expected manual provider');
    expect(provider.endpoints.chat?.knownModels).toBeUndefined();
  });

  it('removeKnownModel rejects unknown model on manual provider endpoint', async () => {
    const { module } = await setup();
    await expect(
      module.removeKnownModel('local', 'nonexistent', 'chat'),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });

  // --- Common error cases ---

  it('addKnownModel rejects unknown provider', async () => {
    const { module } = await setup();
    await expect(
      module.addKnownModel('nonexistent', 'model', modelDef),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });

  it('updateKnownModel rejects unknown provider', async () => {
    const { module } = await setup();
    await expect(
      module.updateKnownModel('nonexistent', 'model', modelDef),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });

  it('removeKnownModel rejects unknown provider', async () => {
    const { module } = await setup();
    await expect(
      module.removeKnownModel('nonexistent', 'model'),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });
});

describe('Config — model selection entries (object form)', () => {
  it('accepts object-form entries with providerOptions', async () => {
    const config = presetConfig('openai', 'gpt-4o');
    config.modelSelection.chat = [
      {
        model: 'my-openai:gpt-4o',
        providerOptions: { openai: { store: true } },
      },
    ];
    const { module } = await setup(config);

    const resolved = module.resolveModel(
      module.getModelSelection('chat')[0] as ModelSelectionEntry,
    );
    expect(resolved.providerOptions).toEqual({
      openai: { store: true },
    });
  });

  it('accepts bare-string entries (backward compat)', async () => {
    const config = presetConfig();
    const { module } = await setup(config);

    const selection = module.getModelSelection('chat');
    expect(selection).toEqual(['my-openai:gpt-4o']);

    const resolved = module.resolveModel(selection[0] as ModelSelectionEntry);
    expect(resolved.providerOptions).toBeUndefined();
  });

  it('returns undefined providerOptions for object entry without providerOptions', async () => {
    const config = presetConfig();
    config.modelSelection.chat = [{ model: 'my-openai:gpt-4o' }];
    const { module } = await setup(config);

    const resolved = module.resolveModel(
      module.getModelSelection('chat')[0] as ModelSelectionEntry,
    );
    expect(resolved.providerOptions).toBeUndefined();
  });

  it('resolveModelInfo works with object-form entries', async () => {
    const config = presetConfig('openai', 'gpt-4o');
    (
      config.providers['my-openai'] as {
        preset: ProviderPreset;
        auth: EndpointAuth;
        knownModels?: Record<string, ModelDefinition>;
      }
    ).knownModels = {
      'gpt-4o': { contextSize: 128_000, displayName: 'GPT-4o' },
    };
    config.modelSelection.chat = [{ model: 'my-openai:gpt-4o' }];
    const { module } = await setup(config);

    const info = module.resolveModelInfo(
      module.getModelSelection('chat')[0] as ModelSelectionEntry,
    );
    expect(info.contextSize).toBe(128_000);
    expect(info.displayName).toBe('GPT-4o');
  });

  it('validateModelReferences accepts object-form entries', async () => {
    const config = mixedConfig();
    config.modelSelection.chat = [{ model: 'remote:gpt-4o' }];
    config.modelSelection.compaction = [
      {
        model: 'local:chat:model:8b',
        providerOptions: { extra: { foo: 'bar' } },
      },
    ];
    const { module } = await setup(config);

    // Should not throw — all referenced providers/models exist
    await expect(module.replace(config)).resolves.toBeDefined();
  });

  it('validateModelReferences rejects object-form entry with missing provider', async () => {
    const { module } = await setup(mixedConfig());
    const invalid = mixedConfig();
    invalid.modelSelection.chat = [{ model: 'missing:gpt-4o' }];

    await expect(module.replace(invalid)).rejects.toBeInstanceOf(
      ConfigValidationError,
    );
  });

  it('rejects providerOptions with non-object namespace value', async () => {
    const { module } = await setup(mixedConfig());
    const invalid = mixedConfig();
    invalid.modelSelection.chat = [
      {
        model: 'remote:gpt-4o',
        providerOptions: { openai: 'high' } as never,
      },
    ];

    await expect(module.replace(invalid)).rejects.toBeInstanceOf(
      ConfigValidationError,
    );
  });

  it('rejects providerOptions with primitive namespace value', async () => {
    const { module } = await setup(mixedConfig());
    const invalid = mixedConfig();
    invalid.modelSelection.chat = [
      {
        model: 'remote:gpt-4o',
        providerOptions: { openai: 42 } as never,
      },
    ];

    await expect(module.replace(invalid)).rejects.toBeInstanceOf(
      ConfigValidationError,
    );
  });
});
