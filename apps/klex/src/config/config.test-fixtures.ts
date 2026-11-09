import type { KlexConfig, ModelSelection } from './schema';

export const emptyModelSelection: ModelSelection = {
  chat: [],
  compaction: [],
  memory: [],
  imageVision: [],
  audioListening: [],
  consult: [],
  instincts: [],
  voice: { sts: [] },
};

export const defaultInstinctConfig: KlexConfig['instinct'] = {
  enabled: true,
  timeoutMs: 8_000,
  classifierTimeoutMs: 4_000,
  historyCharacterCap: 16_000,
  messageCharacterCap: 2_000,
  contextCharacterCap: 2_000,
};

export const completeV2Config: KlexConfig = {
  configVersion: 2,
  officialName: 'Fixture Agent',
  providers: {
    'openai-primary': {
      type: 'openai',
      settings: { apiKey: '${env:OPENAI_PRIMARY_KEY}' },
      knownModels: {
        'gpt-4.1': { displayName: 'Primary GPT', contextSize: 128_000 },
      },
    },
    'openai-secondary': {
      type: 'openai',
      settings: { apiKey: '${env:OPENAI_SECONDARY_KEY}' },
    },
    'openai-internal': {
      type: 'chat-completions',
      settings: {
        baseUrl: 'https://models.internal.example/v1',
        apiKey: '${env:INTERNAL_OPENAI_KEY}',
        headers: { Authorization: 'Bearer ${env:INTERNAL_OPENAI_KEY}' },
      },
    },
    'custom-chat': {
      type: 'chat-completions',
      settings: {
        baseUrl: 'https://inference.example/v1',
        apiKey: '${env:CUSTOM_API_KEY}',
      },
      knownModels: {
        'org:model:v2': {
          displayName: 'Manually overridden name',
          contextSize: 65_536,
          capabilities: {
            input: {
              image: {
                mediaTypes: ['image/png', 'image/jpeg'],
                maxBytes: 10_000_000,
              },
            },
          },
        },
      },
    },
  },
  modelSelection: {
    ...emptyModelSelection,
    chat: [
      { providerId: 'openai-primary', modelId: 'gpt-4.1' },
      {
        providerId: 'custom-chat',
        modelId: 'org:model:v2',
        providerOptions: { openai: { reasoningEffort: 'high' } },
      },
    ],
    compaction: [{ providerId: 'openai-secondary', modelId: 'gpt-4.1-mini' }],
    imageVision: [{ providerId: 'custom-chat', modelId: 'org:model:v2' }],
    consult: [{ providerId: 'openai-primary', modelId: 'gpt-4.1' }],
  },
  mcpServers: {
    workspace: { command: 'workspace-mcp', args: ['--root', '/workspace'] },
  },
  timezone: 'UTC',
  instinct: defaultInstinctConfig,
  extensions: {
    memory: {
      episodes: {
        maxCharacters: 50_000,
        maxDurationMs: 3_600_000,
        idleTimeoutMs: 600_000,
      },
    },
  },
};

const { instincts: _instincts, ...historicalModelSelection } =
  completeV2Config.modelSelection;

const { instinct: _instinct, ...releasedConfig } = completeV2Config;
const { extensions: _extensions, ...releasedV4Config } = releasedConfig;

/** Frozen schema-6 shape from v0.26.0. Do not derive it from runtime defaults. */
export const completeV6StoredConfig = {
  configVersion: 2,
  officialName: 'Released Fixture Agent',
  timezone: 'Europe/Berlin',
  providers: {
    'openai-primary': {
      type: 'openai',
      settings: { apiKey: '${env:OPENAI_PRIMARY_KEY}' },
      knownModels: {
        'gpt-4.1': { displayName: 'Saved model', contextSize: 128_000 },
      },
    },
  },
  modelSelection: {
    chat: [
      {
        providerId: 'openai-primary',
        modelId: 'gpt-4.1',
        providerOptions: { openai: { reasoningEffort: 'high' } },
      },
    ],
    compaction: [],
    memory: [],
    imageVision: [],
    audioListening: [],
    consult: [],
    instincts: [
      {
        providerId: 'openai-primary',
        modelId: 'gpt-4.1',
        api: 'generation',
        attemptTimeoutMs: 2_500,
      },
    ],
    voice: { sts: [], tts: [], stt: [] },
  },
  mcpServers: {
    workspace: { command: 'workspace-mcp', args: ['--root', '/workspace'] },
  },
  instinct: {
    enabled: false,
    timeoutMs: 6_000,
    classifierTimeoutMs: 3_000,
    historyCharacterCap: 12_000,
    messageCharacterCap: 1_000,
    contextCharacterCap: 1_000,
  },
  extensions: {
    memory: {
      episodes: {
        maxCharacters: 40_000,
        maxDurationMs: 1_800_000,
        idleTimeoutMs: 300_000,
      },
    },
  },
  sessionHistory: { maxBytes: 33_554_432 },
};

/** Actual released schema 5: no instinct configuration or selection. */
export const completeV5StoredConfig = {
  ...releasedConfig,
  modelSelection: {
    ...historicalModelSelection,
    voice: { ...completeV2Config.modelSelection.voice, tts: [], stt: [] },
  },
};

/** Stored schema 2–4 shape: root memory keys, no `extensions`. */
export const completeV4StoredConfig = {
  ...releasedV4Config,
  modelSelection: {
    ...historicalModelSelection,
    voice: { ...completeV2Config.modelSelection.voice, tts: [], stt: [] },
  },
  episodeFinishIdleTriggerTimeMs: 450_000,
  memoryWriteIntervalMs: 60_000,
  memoryWriteStepInterval: 3,
};
