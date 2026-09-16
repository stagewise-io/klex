import type { ModelMessage } from 'ai';

import type { ResolvedGeminiLiveConfig } from '@/config';
import type {
  InteractionToolDescriptor,
  PreparedInferenceContext,
} from '@/session/interaction';

export type GeminiClientMessage = Readonly<Record<string, unknown>>;

const DEFAULT_INSTRUCTIONS = 'You are Klex. Answer clearly and briefly.';
const DEFAULT_VOICE = 'Kore';

export function geminiSetupMessage(
  config: ResolvedGeminiLiveConfig,
  context: PreparedInferenceContext | undefined,
  resumeHandle?: string,
): GeminiClientMessage {
  const tools = toGeminiTools(context?.tools ?? []);
  return {
    setup: {
      model: `models/${config.modelId}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: DEFAULT_VOICE } },
        },
        ...(config.modelId === 'gemini-3.8-live-extended-thinking' && {
          thinkingConfig: { thinkingLevel: config.thinkingLevel ?? 'medium' },
        }),
      },
      systemInstruction: {
        parts: [{ text: context?.instructions ?? DEFAULT_INSTRUCTIONS }],
      },
      ...(tools.length > 0 && { tools: [{ functionDeclarations: tools }] }),
      realtimeInputConfig: {
        automaticActivityDetection: { disabled: false },
        activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
        turnCoverage: 'TURN_INCLUDES_ALL_INPUT',
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      contextWindowCompression: { slidingWindow: {} },
      sessionResumption: resumeHandle ? { handle: resumeHandle } : {},
    },
  };
}

export function geminiHistoryMessages(
  messages: readonly ModelMessage[],
): GeminiClientMessage[] {
  const turns: Array<{
    role: 'user' | 'model';
    parts: Array<{ text: string }>;
  }> = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    const text = messageText(message);
    if (text.length === 0) continue;
    const role = message.role === 'assistant' ? 'model' : 'user';
    const previous = turns.at(-1);
    if (previous?.role === role) previous.parts.push({ text });
    else turns.push({ role, parts: [{ text }] });
  }
  return turns.length === 0
    ? []
    : [{ clientContent: { turns, turnComplete: false } }];
}

export function geminiTextMessage(
  text: string,
  turnComplete: boolean,
  role: 'user' | 'model' = 'user',
): GeminiClientMessage {
  return {
    clientContent: { turns: [{ role, parts: [{ text }] }], turnComplete },
  };
}

export function geminiAudioMessage(data: Uint8Array): GeminiClientMessage {
  return {
    realtimeInput: {
      audio: {
        mimeType: 'audio/pcm;rate=48000',
        data: Buffer.from(data).toString('base64'),
      },
    },
  };
}

export function geminiToolResponseMessage(
  id: string,
  name: string,
  response: unknown,
): GeminiClientMessage {
  return {
    toolResponse: {
      functionResponses: [{ id, name, response: normalizeResponse(response) }],
    },
  };
}

function toGeminiTools(tools: readonly InteractionToolDescriptor[]) {
  return tools.map((tool) => ({
    name: tool.name,
    ...(tool.description !== undefined && { description: tool.description }),
    parametersJsonSchema: tool.inputSchema,
    behavior: 'NON_BLOCKING',
  }));
}

function messageText(message: ModelMessage): string {
  if (typeof message.content === 'string') return message.content;
  const chunks: string[] = [];
  for (const part of message.content) {
    if (part.type === 'text' && part.text.length > 0) chunks.push(part.text);
    else if (part.type === 'tool-call')
      chunks.push(
        `[Tool call ${part.toolName} (${part.toolCallId})] ${safeJson(part.input)}`,
      );
    else if (part.type === 'tool-result')
      chunks.push(
        `[Tool result ${part.toolName} (${part.toolCallId})] ${safeJson(part.output)}`,
      );
  }
  return chunks.join('\n');
}

function normalizeResponse(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value))
    return value as Record<string, unknown>;
  return { result: value ?? null };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return '"[unserializable]"';
  }
}
