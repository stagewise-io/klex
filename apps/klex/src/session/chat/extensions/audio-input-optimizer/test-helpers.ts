import type { FilePart, ModelMessage, UserContent } from 'ai';
import { vi } from 'vitest';

import type { ExtensionDeps, ResolvedModel } from '../extension-api';
import {
  clearAudioInputOptimizerCache,
  createAudioInputOptimizerExt,
} from './audio-input-optimizer';

export function makeDeps(overrides?: Partial<ExtensionDeps>): ExtensionDeps {
  return {
    getHistory: vi.fn(() => []),
    insertMessageAfter: vi.fn(() => true),
    inbox: {
      send: vi.fn(),
      sendMessage: vi.fn(),
      close: vi.fn(),
    },
    config: {
      getModelSelection: vi.fn(() => []),
      resolveModelInfo: vi.fn(() => ({
        contextSize: 128_000,
        displayName: undefined,
        inputCapabilities: {},
      })),
    } as unknown as ExtensionDeps['config'],
    generateText: vi.fn(),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
    } as unknown as ExtensionDeps['logger'],
    logging: {} as unknown as ExtensionDeps['logging'],
    mcp: {} as unknown as ExtensionDeps['mcp'],
    sessionId: 'test-session',
    getDataDir: vi.fn(() => '/tmp/test-ext-data'),
    ...overrides,
  };
}

export const DEFAULT_AUDIO_CAPS = {
  mediaTypes: ['audio/wav', 'audio/mpeg'],
  maxBytes: 25_165_824, // 24 MB
};

export function makeModel(overrides?: Partial<ResolvedModel>): ResolvedModel {
  return {
    modelId: 'test:model',
    displayName: 'Test Model',
    contextSize: 128_000,
    inputCapabilities: {
      audio: DEFAULT_AUDIO_CAPS,
    },
    ...overrides,
  };
}

/** Generates a valid WAV buffer with a short sine tone. */
export function makeWavBuffer(
  durationMs: number,
  sampleRate = 44100,
  channels = 1,
): Buffer {
  const numSamples = Math.floor((sampleRate * durationMs) / 1000);
  const dataSize = numSamples * channels * 2; // 16-bit PCM
  const buffer = Buffer.alloc(44 + dataSize);
  // RIFF header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  // fmt chunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // chunk size
  buffer.writeUInt16LE(1, 20); // PCM format
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * 2, 28); // byte rate
  buffer.writeUInt16LE(channels * 2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  // data chunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  // Sine wave samples
  for (let i = 0; i < numSamples; i++) {
    const sample = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 32767 * 0.5;
    buffer.writeInt16LE(Math.floor(sample), 44 + i * channels * 2);
  }
  return buffer;
}

export function makeFilePart(
  buffer: Buffer,
  mediaType = 'audio/wav',
  filename?: string,
): FilePart {
  return {
    type: 'file',
    data: { type: 'data', data: buffer },
    mediaType,
    ...(filename !== undefined && { filename }),
  };
}

export function makeUserMessage(content: UserContent): ModelMessage {
  return { role: 'user', content };
}

/** Extracts the content array from a transformed user message. */
export function getContent(
  result: ModelMessage[],
  msgIndex: number,
): Array<Record<string, unknown>> {
  const msg = result[msgIndex] as ModelMessage;
  return msg.content as unknown as Array<Record<string, unknown>>;
}

export async function runTransformer(
  history: ModelMessage[],
  model: ResolvedModel,
  deps?: ExtensionDeps,
): Promise<ModelMessage[]> {
  const ext = createAudioInputOptimizerExt.create(deps ?? makeDeps());
  const result = await ext.contextTransformer?.(history, model);
  return Array.isArray(result)
    ? result
    : (result as { history: ModelMessage[] }).history;
}

/** Builds a successful generateText result. */
export function genSuccess(text: string): {
  success: true;
  text: string;
  modelId: string;
  usage: Record<string, unknown>;
} {
  return {
    success: true,
    text,
    modelId: 'audio:model',
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
  };
}

/** Builds a failed generateText result. */
export function genFailure(): {
  success: false;
  failureReason: 'all-models-failed';
} {
  return { success: false, failureReason: 'all-models-failed' };
}

/** Config mock that returns audio models with audio capability. */
export function makeAudioConfig(
  audioModelIds: string[],
  chatModelIds: string[] = [],
  audioChatModelIds: string[] = [],
) {
  return {
    getModelSelection: vi.fn((purpose: string) => {
      if (purpose === 'audioListening') return audioModelIds;
      if (purpose === 'chat') return chatModelIds;
      return [];
    }),
    resolveModelInfo: vi.fn((id: string) => {
      if (audioModelIds.includes(id) || audioChatModelIds.includes(id)) {
        return {
          contextSize: 128_000,
          displayName: undefined,
          inputCapabilities: { audio: DEFAULT_AUDIO_CAPS },
        };
      }
      return {
        contextSize: 128_000,
        displayName: undefined,
        inputCapabilities: {},
      };
    }),
  } as unknown as ExtensionDeps['config'];
}

export { clearAudioInputOptimizerCache, createAudioInputOptimizerExt };
