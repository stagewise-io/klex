import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, it, vi } from 'vitest';

import { createLogger } from '@stagewise/logger';

import {
  CONFIG_FILE_NAME,
  CONFIG_STORE_DEFINITION,
  createConfig,
  type ModelSelection,
} from '@/config';
import { createLocalData } from '@/local-data';
import {
  createProviderRegistry,
  type ProviderDefinition,
} from '@/provider-registry';
import { KLEX_VERSION } from '@/release';

import {
  createProvider,
  createProviderRoute,
  getProviders,
  getProvidersRoute,
} from './providers';
import { modelSelectionSchema, providersResponseSchema } from './schemas';
import {
  getModelSelection,
  getModelSelectionRoute,
  patchModelSelection,
  patchModelSelectionRoute,
} from './settings';
import { setupTestApp } from './test-utils';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const emptySelection: ModelSelection = {
  chat: [],
  compaction: [],
  memory: [],
  imageVision: [],
  audioListening: [],
  consult: [],
  instincts: [],
  voice: { sts: [] },
};

async function createBot(definition: ProviderDefinition) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'klex-provider-copy-'));
  cleanup.push(() => rm(dataDirectory, { recursive: true, force: true }));
  const logging = createLogger({ console: false });
  await writeFile(
    join(dataDirectory, CONFIG_FILE_NAME),
    JSON.stringify({
      configVersion: 2,
      officialName: 'Copy test',
      providers: {},
      modelSelection: { ...emptySelection, instincts: undefined },
      mcpServers: {},
    }),
  );
  await createLocalData({
    logging,
    dataDirectory,
    klexVersion: KLEX_VERSION,
    stores: [CONFIG_STORE_DEFINITION],
  }).start();
  const config = createConfig({
    logging,
    dataDirectory,
    env: { COPY_KEY: 'resolved-copy-key' },
  });
  await config.start();
  cleanup.push(() => config.close());
  const providerRegistry = createProviderRegistry({
    logging,
    config,
    definitions: [definition],
  });
  await providerRegistry.start();
  cleanup.push(() => providerRegistry.close());
  const deps = { providerRegistry, config, logger: logging, timezone: 'UTC' };
  const app = setupTestApp((route) => {
    route.openapi(getProvidersRoute, getProviders(deps));
    route.openapi(createProviderRoute, createProvider(deps));
    route.openapi(getModelSelectionRoute, getModelSelection(deps));
    route.openapi(patchModelSelectionRoute, patchModelSelection(deps));
  });
  return { app, config, providerRegistry };
}

it('copies providers, exact custom metadata and all selections between real bots without model discovery', async () => {
  const discoverModels = vi.fn<
    NonNullable<ProviderDefinition['discoverModels']>
  >(async () => ({
    ok: false,
    code: 'discovery_failed',
    message: 'Offline',
  }));
  const definition: ProviderDefinition = {
    type: 'openai',
    metadata: { displayName: 'Copy test', description: 'Offline provider' },
    usageGuidance: 'Test provider for configuration transfer.',
    createLanguageModel: () => new MockLanguageModelV4(),
    discoverModels,
    listVoices: async () => ({
      ok: true,
      code: 'available',
      value: {
        voices: [
          { voiceId: 'cedar', displayName: 'Cedar', isPreviewAvailable: false },
        ],
      },
    }),
    testConnection: async () => ({
      ok: true,
      code: 'available',
      value: { latencyMs: 0 },
    }),
  };
  const source = await createBot(definition);
  const target = await createBot(definition);
  const knownModels = {
    'vendor/custom:model': {
      kind: 'language' as const,
      displayName: 'Custom model',
      contextSize: 32768,
      capabilities: {
        tools: true,
        input: { image: {}, audio: {} },
        voice: { sts: true, tts: true, stt: true },
      },
    },
    'empty-definition': {},
    'metadata-only': { displayName: 'Keep only this override' },
  };
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Config resolves this literal environment reference.
  const environmentReference = '${env:COPY_KEY}';
  expect(
    await source.providerRegistry.addInstance({
      id: 'primary',
      type: 'openai',
      settings: {
        apiKey: environmentReference,
        headers: { 'x-custom': 'custom-header-value' },
      },
      knownModels,
    }),
  ).toMatchObject({ ok: true });
  expect(
    await source.providerRegistry.addInstance({
      id: 'fallback',
      type: 'openai',
      settings: { apiKey: 'other-copy-key' },
    }),
  ).toMatchObject({ ok: true });
  const reference = {
    providerId: 'primary',
    modelId: 'vendor/custom:model',
    providerOptions: { openai: { reasoningEffort: 'low' } },
  };
  const selection: ModelSelection = {
    chat: [
      reference,
      { providerId: 'fallback', modelId: 'fallback/opaque:model' },
    ],
    compaction: [reference],
    memory: [reference],
    imageVision: [reference],
    audioListening: [reference],
    consult: [reference],
    instincts: [{ ...reference, api: 'generation', attemptTimeoutMs: 1234 }],
    voice: {
      sts: [{ ...reference, voiceId: 'cedar' }],
    },
  };
  expect(
    await source.providerRegistry.updateModelSelection(selection),
  ).toMatchObject({ ok: true });

  const response = await source.app.request(
    '/v1/providers?includeSecrets=true',
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  const exported = providersResponseSchema.parse(await response.json());
  expect(exported.secretsIncluded).toBe(true);
  expect(
    exported.providers.find(({ id }) => id === 'primary')?.knownModels,
  ).toEqual(knownModels);
  expect(
    exported.providers.find(({ id }) => id === 'fallback')?.knownModels,
  ).toEqual({});
  for (const provider of exported.providers) {
    const created = await target.app.request('/v1/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: `copied-${provider.id}`,
        type: provider.type,
        settings: provider.settings,
        knownModels: provider.knownModels,
      }),
    });
    expect(created.status).toBe(201);
    expect(JSON.stringify(await created.json())).not.toContain('copy-key');
  }
  const sourceSelection = modelSelectionSchema.parse(
    await (await source.app.request('/v1/settings/model-selection')).json(),
  );
  const remap = <T extends { providerId: string }>(entries: T[]) =>
    entries.map((entry) => ({
      ...entry,
      providerId: `copied-${entry.providerId}`,
    }));
  const expected = {
    chat: remap(sourceSelection.chat),
    compaction: remap(sourceSelection.compaction),
    memory: remap(sourceSelection.memory),
    imageVision: remap(sourceSelection.imageVision),
    audioListening: remap(sourceSelection.audioListening),
    consult: remap(sourceSelection.consult),
    instincts: remap(sourceSelection.instincts),
    voice: {
      sts: remap(sourceSelection.voice.sts),
    },
  };
  const saved = await target.app.request('/v1/settings/model-selection', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(expected),
  });
  expect(saved.status).toBe(200);
  expect(modelSelectionSchema.parse(await saved.json())).toEqual(expected);
  expect(target.config.get().providers['copied-primary']).toEqual({
    type: 'openai',
    settings: {
      apiKey: 'resolved-copy-key',
      headers: { 'x-custom': 'custom-header-value' },
    },
    knownModels,
  });
  expect(source.config.get().providers.primary?.settings.apiKey).toBe(
    environmentReference,
  );
  expect(discoverModels).not.toHaveBeenCalled();

  const ordinary = await source.app.request('/v1/providers');
  const redacted = providersResponseSchema.parse(await ordinary.json());
  expect(redacted.secretsIncluded).toBeUndefined();
  expect(
    redacted.providers.every((provider) => provider.knownModels === undefined),
  ).toBe(true);
  expect(JSON.stringify(redacted)).not.toContain('copy-key');

  const invalid = await target.app.request('/v1/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'invalid',
      type: 'openai',
      settings: { apiKey: 'secret' },
      knownModels: { custom: { contextSize: -1 } },
    }),
  });
  expect(invalid.status).toBe(400);
  expect(target.config.get().providers.invalid).toBeUndefined();
});
