import { randomUUID } from 'node:crypto';

import {
  EmptyResponseBodyError,
  type FinishReason,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  readUIMessageStream,
  streamText,
  toUIMessageStream,
} from 'ai';

import type { ModuleLogger } from '@stagewise/logger';

import type { ModelId } from '@/config';
import type { AgentTools } from '@/session/tools';
import type { ExtendedUIMessage } from '@/session/types';

import systemPrompt from './system-prompt.md';
import { toolsWithoutExecute } from './tools-without-execute';

export type StreamedGenerationOutput = {
  message: ExtendedUIMessage;
  finishReason: FinishReason;
  error?: unknown;
  usage: LanguageModelUsage;
};

export interface RunStreamedGenerationParams {
  model: LanguageModel;
  modelMessages: ModelMessage[];
  tools: AgentTools;
  onUpdate: (msg: ExtendedUIMessage) => void;
  abortSignal: AbortSignal;
  logger: ModuleLogger;
  getChatModelId: () => ModelId;
  /** UUID of the session instance — passed to telemetry via runtimeContext. */
  sessionId: string;
  /** Whether the history was compacted by an extension before this generation. */
  compacted: boolean;
}

/**
 * Runs a single model generation: streams text, converts to UI message
 * stream, and returns the final message + finish metadata.
 *
 * The generation span is created by the custom Telemetry integration
 * (registered in `tracing.ts`) — it nests under the active OTel context
 * (the step context) automatically. No manual span management needed here.
 */
export async function runStreamedGeneration(
  params: RunStreamedGenerationParams,
): Promise<StreamedGenerationOutput> {
  const id = randomUUID();
  params.logger.trace('START_GENERATION', { id });

  let message: ExtendedUIMessage = {
    id: id,
    role: 'assistant',
    parts: [],
  };

  const result = streamText({
    model: params.model,
    tools: toolsWithoutExecute(params.tools),
    instructions: {
      role: 'system',
      content: systemPrompt,
    },
    telemetry: {
      isEnabled: true,
      functionId: 'chat-session',
    },
    runtimeContext: {
      'conversation.id': params.sessionId,
      'conversation.compacted': params.compacted,
    },
    abortSignal: params.abortSignal,
    timeout: {
      chunkMs: 10000,
    },
    maxRetries: 0,
    messages: params.modelMessages,
  });

  const uiMsgChunkStream = toUIMessageStream<AgentTools, ExtendedUIMessage>({
    stream: result.stream,
    generateMessageId: randomUUID,
    tools: params.tools,
  });
  const uiMsgUpdateStream = readUIMessageStream<ExtendedUIMessage>({
    stream: uiMsgChunkStream,
    message: message,
  });

  for await (const uiMessage of uiMsgUpdateStream) {
    message = uiMessage;
    params.onUpdate?.(uiMessage);
  }

  const finishReason = await result.finishReason;
  const rawFinishReason = await result.rawFinishReason;
  const usage = await result.usage;

  if (message.parts.length === 0) {
    throw new EmptyResponseBodyError({
      message: 'No content received during generation.',
    });
  }

  const response: StreamedGenerationOutput = {
    message: message,
    finishReason: finishReason,
    error: finishReason === 'error' ? rawFinishReason : undefined,
    usage: usage,
  };

  params.logger.trace('FINISH_GENERATION', response);
  return response;
}
