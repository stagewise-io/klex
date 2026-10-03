import type { KlexConfig, ModelSelection } from './types';

export const emptyModelSelection: ModelSelection = {
  chat: [],
  compaction: [],
  memory: [],
  imageVision: [],
  audioListening: [],
  consult: [],
  instincts: [],
  voice: { sts: [], tts: [], stt: [] },
};

export const defaultInstinctConfig: KlexConfig['instinct'] = {
  enabled: true,
  timeoutMs: 8_000,
  classifierTimeoutMs: 4_000,
  recentMessageCount: 5,
  deltaMessageCap: 20,
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

/** Stored schema 5 retains the historical subsystem settings key. */
export const completeV5StoredConfig = {
  ...Object.fromEntries(
    Object.entries(completeV2Config).filter(([key]) => key !== 'instinct'),
  ),
  modelSelection: { ...historicalModelSelection, classifier: [] },
  preflight: defaultInstinctConfig,
};

/** Stored schema 2–4 shape: root memory keys, no `extensions`. */
export const completeV4StoredConfig: Record<string, unknown> = {
  ...Object.fromEntries(
    Object.entries(completeV2Config).filter(
      ([key]) => key !== 'extensions' && key !== 'instinct',
    ),
  ),
  modelSelection: historicalModelSelection,
  episodeFinishIdleTriggerTimeMs: 450_000,
  memoryWriteIntervalMs: 60_000,
  memoryWriteStepInterval: 3,
};
