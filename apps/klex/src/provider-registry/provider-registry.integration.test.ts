import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LanguageModelV4 } from '@ai-sdk/provider';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RootLogger } from '@stagewise/logger';

import {
  CONFIG_FILE_NAME,
  CONFIG_STORE_DEFINITION,
  createConfig,
} from '@/config';
import { emptyModelSelection } from '@/config/config.test-fixtures';
import { createLocalData } from '@/local-data';
import { KLEX_VERSION } from '@/release';

import {
  createProviderRegistry,
  type ProviderDefinition,
} from './provider-registry';
import { openAiProviderDefinition } from './providers/openai';
import { openRouterProviderDefinition } from './providers/openrouter';

const directories: string[] = [];
const logging = {
  child: () => ({
    error: () => undefined,
    info: () => undefined,
    warn: () => undefined,
  }),
} as unknown as RootLogger;
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function createDataDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'klex-provider-integration-'));
  directories.push(path);
  await writeFile(
    join(path, CONFIG_FILE_NAME),
    JSON.stringify({
      configVersion: 2,
      officialName: 'Integration Agent',
      providers: {},
      modelSelection: emptyModelSelection,
      mcpServers: {},
    }),
  );
  await createLocalData({
    logging,
    dataDirectory: path,
    klexVersion: KLEX_VERSION,
    stores: [CONFIG_STORE_DEFINITION],
  }).start();
  return path;
}

describe('provider registry module integration', () => {
  it.each([openAiProviderDefinition, openRouterProviderDefinition])(
    'validates $type credentials before persisting and permits a corrected retry',
    async (definition) => {
      const dataDirectory = await createDataDirectory();
      const config = createConfig({
        logging,
        dataDirectory,
        env: { PROVIDER_KEY: 'valid-secret' },
      });
      await config.start();
      const registry = createProviderRegistry({
        logging,
        config,
        definitions: [definition],
      });
      await registry.start();
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const onChange = vi.fn();
      config.subscribe(onChange);
      const original = await readFile(
        join(dataDirectory, CONFIG_FILE_NAME),
        'utf8',
      );
      try {
        for (const status of [401, 403, 503]) {
          fetchMock.mockResolvedValueOnce(
            new Response('secret upstream body', { status }),
          );
          const result = await registry.addInstance({
            id: 'work',
            type: definition.type,
            settings: { apiKey: 'bad-secret' },
          });
          expect(result).toMatchObject({
            ok: false,
            code:
              status === 503
                ? 'connectivity_failed'
                : 'authentication_required',
          });
          expect(JSON.stringify(result)).not.toMatch(
            /bad-secret|secret upstream body/,
          );
          expect(config.get().providers).toEqual({});
          expect(registry.listInstances()).toEqual([]);
          expect(onChange).not.toHaveBeenCalled();
          expect(
            await readFile(join(dataDirectory, CONFIG_FILE_NAME), 'utf8'),
          ).toBe(original);
        }
        fetchMock.mockResolvedValueOnce(Response.json({ data: [] }));
        const result = await registry.addInstance({
          id: 'work',
          type: definition.type,
          settings: { apiKey: '${env:PROVIDER_KEY}' },
        });
        expect(result.ok).toBe(true);
        const [url, init] = fetchMock.mock.lastCall!;
        expect(String(url)).toBe(
          definition.type === 'openrouter'
            ? 'https://openrouter.ai/api/v1/key'
            : 'https://api.openai.com/v1/models',
        );
        expect(init.headers.Authorization).toBe('Bearer valid-secret');
        expect(config.get().providers.work?.settings.apiKey).toBe(
          '${env:PROVIDER_KEY}',
        );
        expect(onChange).toHaveBeenCalledTimes(1);
      } finally {
        await registry.close();
        await config.close();
      }
    },
  );

  it('runs the provider lifecycle across config, discovery, and runtime resolution', async () => {
    const discoverModels = vi.fn(async () => ({
      ok: true as const,
      code: 'available' as const,
      value: [
        { modelId: 'autodetected-only' },
        { modelId: 'vendor:model:v2', displayName: 'Discovered model' },
      ],
    }));
    const createLanguageModel = vi.fn(
      (instance, modelId) =>
        ({ providerId: instance.id, modelId }) as unknown as LanguageModelV4,
    );
    const definition: ProviderDefinition = {
      type: 'openrouter',
      usageGuidance:
        'Use this provider only for integrated registry lifecycle tests; use production provider definitions for real model traffic.',
      metadata: {
        displayName: 'Integration Provider',
        description: 'Exercises the complete provider lifecycle.',
      },
      preflightCreate: async (settings) =>
        settings.apiKey === 'blocked'
          ? {
              ok: false,
              code: 'authentication_required',
              message: 'Authentication failed',
              remediation: 'Provide a valid API key.',
            }
          : { ok: true, code: 'available', value: undefined },
      createLanguageModel,
      discoverModels,
      resolveModelMetadata: (modelId) =>
        modelId === 'vendor:model:v2'
          ? {
              kind: 'language',
              contextSize: 128_000,
              capabilities: { input: { image: { maxBytes: 10_000_000 } } },
              provenance: [{ source: 'provider-exact' }],
            }
          : modelId === 'catalog-only'
            ? {
                kind: 'language',
                contextSize: 64_000,
                provenance: [{ source: 'provider-exact' }],
              }
            : modelId === 'future-family'
              ? {
                  kind: 'language',
                  capabilities: { input: { image: {} } },
                  provenance: [{ source: 'provider-family' }],
                }
              : undefined,
      testConnection: async (instance) => ({
        ok: true,
        code: 'available',
        value: { latencyMs: 17, target: String(instance.settings.appName) },
      }),
    };
    const headersDefinition: ProviderDefinition = {
      type: 'chat-completions',
      usageGuidance:
        'Use this provider only to verify embedded environment references in secret header maps.',
      metadata: {
        displayName: 'Header Integration Provider',
        description: 'Exercises secret header persistence.',
      },
      createLanguageModel,
      testConnection: async () => ({
        ok: true,
        code: 'available',
        value: { latencyMs: 0 },
      }),
    };

    const config = createConfig({
      logging,
      dataDirectory: await createDataDirectory(),
      env: { PRIMARY_KEY: 'primary', SECONDARY_KEY: 'secondary' },
    });
    await config.start();
    const registry = createProviderRegistry({
      logging,
      definitions: [definition, headersDefinition],
      config,
    });
    await registry.start();

    await expect(
      registry.preflightCreate('openrouter', { apiKey: 'blocked' }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'authentication_required',
      remediation: 'Provide a valid API key.',
    });
    await expect(
      registry.preflightCreate('openrouter', { apiKey: 'secret' }),
    ).resolves.toMatchObject({ ok: true });

    await expect(
      registry.addInstance({
        id: 'literal-secret',
        type: 'openrouter',
        settings: { apiKey: 'direct-api-key' },
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { settings: { apiKey: { configured: true } } },
    });
    expect(config.get().providers['literal-secret']?.settings.apiKey).toBe(
      'direct-api-key',
    );
    await expect(
      registry.updateInstance('literal-secret', {
        settings: { apiKey: 'updated-direct-api-key' },
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { settings: { apiKey: { configured: true } } },
    });
    expect(config.get().providers['literal-secret']?.settings.apiKey).toBe(
      'updated-direct-api-key',
    );
    await expect(
      registry.removeInstance('literal-secret'),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      registry.addInstance({
        id: 'embedded-header-secret',
        type: 'chat-completions',
        settings: {
          baseUrl: 'https://example.test/v1',
          headers: {
            Authorization: `Bearer \${env:PRIMARY_KEY}`,
            'X-Region': `\${env:SECONDARY_KEY}`,
          },
        },
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      registry.updateInstance('embedded-header-secret', {
        settings: { headers: { Authorization: null } },
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(
      config.get().providers['embedded-header-secret']?.settings.headers,
    ).toEqual({ 'X-Region': `\${env:SECONDARY_KEY}` });
    await expect(
      registry.removeInstance('embedded-header-secret'),
    ).resolves.toMatchObject({ ok: true });

    const concurrentAdds = await Promise.all(
      ['provider-primary', 'provider-secondary'].map((id, index) =>
        registry.addInstance({
          id,
          type: 'openrouter',
          settings: {
            apiKey: `\${env:${index === 0 ? 'PRIMARY_KEY' : 'SECONDARY_KEY'}}`,
            appName: id,
          },
        }),
      ),
    );
    expect(concurrentAdds).toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true }),
    ]);
    expect(registry.listInstances()).toHaveLength(2);
    expect(registry.listInstances()[0]?.settings.apiKey).toEqual({
      configured: true,
    });

    await expect(
      registry.updateInstance('provider-primary', {
        settings: { appName: 'updated-region' },
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(config.get().providers['provider-primary']?.settings).toEqual({
      apiKey: `\${env:PRIMARY_KEY}`,
      appName: 'updated-region',
    });
    await expect(
      registry.updateInstance('provider-primary', {
        settings: { appName: null },
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(config.get().providers['provider-primary']?.settings).toEqual({
      apiKey: `\${env:PRIMARY_KEY}`,
    });
    await registry.updateInstance('provider-primary', {
      settings: { appName: 'updated-region' },
    });

    await registry.listModels('provider-primary');
    await registry.listModels('provider-primary');
    expect(discoverModels).toHaveBeenCalledTimes(1);
    await expect(
      registry.updateModelSelection({
        chat: [
          { providerId: 'provider-primary', modelId: 'autodetected-only' },
        ],
      }),
    ).resolves.toMatchObject({ ok: true, value: { warnings: [] } });
    await expect(
      registry.updateModelSelection({
        chat: [
          { providerId: 'provider-primary', modelId: 'autodetected-only' },
          { providerId: 'provider-primary', modelId: 'unknown-model' },
        ],
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { warnings: [{ modelId: 'unknown-model' }] },
    });
    await expect(
      registry.updateModelSelection({
        chat: [
          { providerId: 'provider-primary', modelId: 'unknown-model' },
          { providerId: 'provider-primary', modelId: 'autodetected-only' },
        ],
      }),
    ).resolves.toMatchObject({ ok: true, value: { warnings: [] } });
    await expect(
      registry.addKnownModel('provider-primary', 'vendor:model:v2', {
        displayName: 'Manual override',
        contextSize: 32_000,
        capabilities: { input: { audio: {} } },
      }),
    ).resolves.toMatchObject({ ok: true });
    const models = await registry.listModels('provider-primary');
    expect(models).toMatchObject({
      ok: true,
      value: [
        {
          modelId: 'autodetected-only',
          source: 'discovered',
          provenance: [{ source: 'discovered' }],
        },
        {
          modelId: 'vendor:model:v2',
          displayName: 'Manual override',
          contextSize: 32_000,
          kind: 'language',
          capabilities: {
            input: { audio: {}, image: { maxBytes: 10_000_000 } },
          },
          source: 'merged',
          provenance: [
            { source: 'provider-exact' },
            { source: 'discovered' },
            { source: 'user' },
          ],
        },
      ],
    });
    expect(discoverModels).toHaveBeenCalledTimes(2);

    await expect(
      registry.updateModelSelection({
        chat: [{ providerId: 'provider-primary', modelId: 'catalog-only' }],
      }),
    ).resolves.toMatchObject({ ok: true, value: { warnings: [] } });
    await expect(
      registry.updateModelSelection({
        chat: [{ providerId: 'provider-primary', modelId: 'future-family' }],
      }),
    ).resolves.toMatchObject({ ok: true, value: { warnings: [] } });
    await expect(
      registry.updateModelSelection({
        chat: [{ providerId: 'provider-primary', modelId: 'missing-metadata' }],
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        warnings: [
          {
            modelId: 'missing-metadata',
            message: expect.stringContaining(
              "Capabilities for model 'missing-metadata' could not be determined",
            ),
          },
        ],
      },
    });
    expect(config.get().modelSelection.chat).toEqual([
      { providerId: 'provider-primary', modelId: 'missing-metadata' },
    ]);
    const missingMetadata = {
      providerId: 'provider-primary',
      modelId: 'missing-metadata',
    };
    expect(() => registry.resolveModelInfo(missingMetadata)).not.toThrow();
    expect(() => registry.getLanguageModel(missingMetadata)).not.toThrow();

    const selection = {
      providerId: 'provider-primary',
      modelId: 'vendor:model:v2',
    };
    await expect(
      registry.updateModelSelection({ chat: [selection] }),
    ).resolves.toMatchObject({ ok: true, value: { warnings: [] } });
    await expect(
      registry.updateModelSelection({ consult: [selection] }),
    ).resolves.toMatchObject({ ok: true, value: { warnings: [] } });
    expect(config.get().modelSelection.consult).toEqual([selection]);
    await expect(
      registry.updateModelSelection({
        voice: { sts: [selection], tts: [], stt: [] },
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'invalid_configuration',
    });
    expect(config.get().modelSelection.voice.sts).toEqual([]);
    expect(registry.resolveModelInfo(selection)).toMatchObject({
      contextSize: 32_000,
      inputCapabilities: {
        audio: {},
        image: { maxBytes: 10_000_000 },
      },
    });
    const runtimeModel = registry.getLanguageModel(selection);
    expect(runtimeModel).toMatchObject({
      providerId: 'provider-primary',
      modelId: 'vendor:model:v2',
    });
    expect(createLanguageModel).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'provider-primary' }),
      'vendor:model:v2',
    );

    await expect(registry.testConnection('provider-primary')).resolves.toEqual({
      ok: true,
      code: 'available',
      value: { latencyMs: 17, target: 'updated-region' },
    });
    expect(
      registry.listInstances().find(({ id }) => id === 'provider-primary')
        ?.operations.remove,
    ).toEqual({ available: true });
    await expect(
      registry.removeInstance('provider-primary'),
    ).resolves.toMatchObject({ ok: true });
    expect(config.get().providers['provider-primary']).toBeUndefined();
    expect(config.get().providers['provider-secondary']).toBeDefined();
    expect(config.get().modelSelection.chat).toEqual([]);
    expect(config.get().modelSelection.consult).toEqual([]);
    await expect(
      registry.listModels('provider-primary'),
    ).resolves.toMatchObject({
      ok: false,
      code: 'not_found',
    });

    await registry.close();
    await config.close();
  });

  it('carries merged non-secret realtime model metadata without exposing credentials', async () => {
    const definition: ProviderDefinition = {
      type: 'openai',
      usageGuidance:
        'Use this provider only to verify realtime model metadata resolution; use the production OpenAI definition for real traffic.',
      metadata: {
        displayName: 'Realtime Integration Provider',
        description: 'Exercises realtime provider metadata resolution.',
      },
      createLanguageModel: (instance, modelId) =>
        ({ providerId: instance.id, modelId }) as unknown as LanguageModelV4,
      // Maintained metadata is richer than the persisted configuration and must win.
      resolveModelMetadata: (modelId) =>
        modelId === 'gpt-realtime'
          ? {
              kind: 'language',
              displayName: 'Maintained Realtime',
              contextSize: 32_000,
              capabilities: {
                voice: { sts: true },
                input: { audio: { mediaTypes: ['audio/pcm'] } },
              },
              provenance: [{ source: 'provider-exact' }],
            }
          : undefined,
      testConnection: async () => ({
        ok: true,
        code: 'available',
        value: { latencyMs: 1 },
      }),
    };

    const config = createConfig({
      logging,
      dataDirectory: await createDataDirectory(),
      env: { REALTIME_KEY: 'sk-realtime' },
    });
    await config.start();
    const registry = createProviderRegistry({
      logging,
      definitions: [definition],
      config,
    });
    await registry.start();

    expect(registry.resolveRealtimeProvider()).toBeUndefined();

    await expect(
      registry.addInstance({
        id: 'openai-voice',
        type: 'openai',
        settings: { apiKey: `\${env:REALTIME_KEY}` },
      }),
    ).resolves.toMatchObject({ ok: true });
    const selection = { providerId: 'openai-voice', modelId: 'gpt-realtime' };
    await expect(
      registry.updateModelSelection({
        voice: { sts: [selection], tts: [], stt: [] },
      }),
    ).resolves.toMatchObject({ ok: true, value: { warnings: [] } });

    const resolved = registry.resolveRealtimeProvider();

    expect(resolved).toMatchObject({
      kind: 'openai-realtime',
      model: {
        modelId: 'gpt-realtime',
        displayName: 'Maintained Realtime',
        contextSize: 32_000,
        inputCapabilities: { audio: { mediaTypes: ['audio/pcm'] } },
      },
      config: {
        modelId: 'gpt-realtime',
        apiKey: 'sk-realtime',
        websocketUrl: expect.stringContaining('gpt-realtime'),
      },
    });
    expect(Object.keys(resolved?.model ?? {}).sort()).toEqual(
      ['modelId', 'displayName', 'contextSize', 'inputCapabilities'].sort(),
    );

    await registry.close();
    await config.close();
  });
});
