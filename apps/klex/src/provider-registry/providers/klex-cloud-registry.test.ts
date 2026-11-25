import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';

import type { RootLogger } from '@stagewise/logger';

import { CONFIG_STORE_DEFINITION, createConfig } from '@/config';
import { createLocalData } from '@/local-data';

import { createProviderRegistry } from '../provider-registry';
import { chatCompletionsProviderDefinition } from './chat-completions';
import { klexCloudProviderDefinition } from './klex-cloud';
import { openAiProviderDefinition } from './openai';
import { responsesProviderDefinition } from './responses';

it('adds a Klex Cloud provider to a migrated managed config with deterministic routing and unchanged STS gates', async () => {
  const logging = {
    child: () => ({ error() {}, info() {}, warn() {} }),
  } as unknown as RootLogger;
  const directory = await mkdtemp(join(tmpdir(), 'klex-cloud-registry-'));
  const path = join(directory, 'config.json');
  await writeFile(
    path,
    await readFile(
      new URL(
        '../../local-data-migration-fixtures/config-v13-managed-baseline.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const localData = createLocalData({
    logging,
    dataDirectory: directory,
    klexVersion: '0.38.2',
    stores: [CONFIG_STORE_DEFINITION],
  });
  const config = createConfig({
    logging,
    dataDirectory: directory,
    env: { PRIMARY_API_KEY: 'synthetic' },
  });
  const registry = createProviderRegistry({
    logging,
    config,
    definitions: [
      openAiProviderDefinition,
      responsesProviderDefinition,
      chatCompletionsProviderDefinition,
      klexCloudProviderDefinition,
    ],
  });
  const fetch = vi.fn(async () =>
    Response.json({
      object: 'list',
      data: [
        { id: 'openai/gpt-6-luna', object: 'model', owned_by: 'openai' },
        { id: 'openai/gpt-audio-mini', object: 'model', owned_by: 'openai' },
        { id: 'anthropic/claude-sonnet-5', object: 'model' },
      ],
    }),
  );
  vi.stubGlobal('fetch', fetch);
  try {
    await localData.start();
    await config.start();
    await registry.start();
    expect(
      await registry.addInstance({
        id: 'stagewise-managed-env',
        type: 'klex-cloud',
        settings: { baseUrl: '${env:GATEWAY_URL}', apiKey: 'sk_sw_token' },
      }),
    ).toMatchObject({ ok: false });
    expect(
      await registry.addInstance({
        id: 'stagewise-managed-cloud',
        type: 'klex-cloud',
        displayName: 'Klex Cloud',
        settings: {
          baseUrl: 'https://gateway.example/v1',
          apiKey: 'sk_sw_token',
          protocols: {
            'vendor/custom-audio': 'chat-completions',
            'openai/gpt-live-1': 'openai-live',
          },
          realtimeBaseUrl: 'wss://gateway.example/v1/realtime',
        },
        knownModels: {
          'openai/gpt-live-1': {
            kind: 'speech-to-speech',
            capabilities: { voice: { sts: true } },
          },
        },
      }),
    ).toMatchObject({ ok: true });
    const provider = (modelId: string) =>
      registry.getLanguageModel({
        providerId: 'stagewise-managed-cloud',
        modelId,
      }).provider;
    const routes = () => ({
      luna: provider('openai/gpt-6-luna'),
      audio: provider('openai/gpt-audio-mini'),
      claude: provider('anthropic/claude-sonnet-5'),
      custom: provider('vendor/custom-audio'),
    });
    const cold = routes();
    expect(cold).toEqual({
      luna: 'klex-cloud.responses',
      audio: 'klex-cloud.chat',
      claude: 'klex-cloud.messages',
      custom: 'klex-cloud.chat',
    });
    expect(await registry.listModels('stagewise-managed-cloud')).toMatchObject({
      ok: true,
    });
    expect(routes()).toEqual(cold);
    expect(fetch).toHaveBeenCalledTimes(1);

    expect(
      await registry.updateModelSelection({
        chat: [
          {
            providerId: 'stagewise-managed-cloud',
            modelId: 'openai/gpt-6-luna',
            providerOptions: { 'klex-cloud': { reasoningEffort: 'medium' } },
          },
        ],
        audioListening: [
          {
            providerId: 'stagewise-managed-cloud',
            modelId: 'openai/gpt-audio-mini',
          },
        ],
      }),
    ).toMatchObject({ ok: true });
    expect(
      await registry.updateModelSelection({
        voice: {
          sts: [
            {
              providerId: 'stagewise-managed-cloud',
              modelId: 'openai/gpt-live-1',
            },
          ],
        },
      }),
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining(
        "Realtime speech requires an 'openai' or 'google-gemini' provider",
      ),
    });

    const stored = JSON.parse(await readFile(path, 'utf8'));
    expect(stored._klex.schemaVersion).toBe(
      CONFIG_STORE_DEFINITION.schemaVersion,
    );
    expect(stored.providers['stagewise-managed-cloud'].settings).toEqual({
      baseUrl: 'https://gateway.example/v1',
      apiKey: 'sk_sw_token',
      protocols: {
        'vendor/custom-audio': 'chat-completions',
        'openai/gpt-live-1': 'openai-live',
      },
      realtimeBaseUrl: 'wss://gateway.example/v1/realtime',
    });
    expect(stored.modelSelection.voice.sts).toEqual([
      { providerId: 'primary', modelId: 'gpt-realtime' },
    ]);
    expect(stored.providers['stagewise-managed-openai'].type).toBe('responses');
  } finally {
    vi.unstubAllGlobals();
    await registry.close();
    await config.close();
    await localData.close();
    await rm(directory, { recursive: true, force: true });
  }
});
