import { describe, expect, it } from 'vitest';

import type { ResolvedGeminiLiveConfig } from '@/config';
import type { PreparedInferenceContext } from '@/session/interaction';

import {
  geminiAudioMessage,
  geminiHistoryMessages,
  geminiSetupMessage,
  geminiTextMessage,
  geminiToolResponseMessage,
} from './session-config';

const context: PreparedInferenceContext = {
  instructions: 'Be concise.',
  messages: [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
  ],
  tools: [{ name: 'clock', inputSchema: { type: 'object' } }],
  model: {
    modelId: 'gemini-3.8-live',
    contextSize: 131_072,
    inputCapabilities: { audio: {} },
  },
  historyRevision: 1,
  updateWatermark: 0,
};

function config(
  modelId: ResolvedGeminiLiveConfig['modelId'],
): ResolvedGeminiLiveConfig {
  return {
    modelId,
    apiKey: 'secret',
    websocketUrl: 'wss://example.test/live',
    ...(modelId.endsWith('extended-thinking') && { thinkingLevel: 'high' }),
  };
}

describe('Gemini Live client messages', () => {
  it('configures audio, transcription, VAD, tools, compression, and resumption', () => {
    expect(
      geminiSetupMessage(config('gemini-3.8-live'), context, 'resume'),
    ).toMatchObject({
      setup: {
        model: 'models/gemini-3.8-live',
        generationConfig: { responseModalities: ['AUDIO'] },
        systemInstruction: { parts: [{ text: 'Be concise.' }] },
        tools: [
          {
            functionDeclarations: [{ name: 'clock', behavior: 'NON_BLOCKING' }],
          },
        ],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        contextWindowCompression: { slidingWindow: {} },
        sessionResumption: { handle: 'resume' },
      },
    });
    expect(
      JSON.stringify(geminiSetupMessage(config('gemini-3.8-live'), context)),
    ).not.toContain('thinkingLevel');
    expect(
      geminiSetupMessage(config('gemini-3.8-live-extended-thinking'), context),
    ).toMatchObject({
      setup: {
        generationConfig: { thinkingConfig: { thinkingLevel: 'high' } },
      },
    });
  });

  it('serializes history, updates, audio, and tool responses', () => {
    expect(geminiHistoryMessages(context.messages)).toHaveLength(1);
    expect(geminiTextMessage('update', true)).toMatchObject({
      clientContent: { turnComplete: true },
    });
    expect(geminiAudioMessage(new Uint8Array([1, 2]))).toEqual({
      realtimeInput: {
        audio: { mimeType: 'audio/pcm;rate=48000', data: 'AQI=' },
      },
    });
    expect(geminiToolResponseMessage('id', 'clock', 3)).toMatchObject({
      toolResponse: {
        functionResponses: [{ id: 'id', response: { result: 3 } }],
      },
    });
  });
});
