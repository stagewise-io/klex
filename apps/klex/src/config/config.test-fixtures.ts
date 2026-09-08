import type { KlexConfig, ModelSelection } from './types';

export const emptyModelSelection: ModelSelection = {
  chat: [],
  compaction: [],
  memory: [],
  imageVision: [],
  audioListening: [],
  voice: { sts: [], tts: [], stt: [] },
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
  },
  mcpServers: {
    workspace: { command: 'workspace-mcp', args: ['--root', '/workspace'] },
  },
  telemetry: { level: 'reduced' },
};
