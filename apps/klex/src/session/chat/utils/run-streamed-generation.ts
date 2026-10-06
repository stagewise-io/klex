import { randomUUID } from 'node:crypto';

import type { JSONObject } from '@ai-sdk/provider';
import {
  EmptyResponseBodyError,
  type FinishReason,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  NoOutputGeneratedError,
  readUIMessageStream,
  streamText,
  toUIMessageStream,
} from 'ai';

import type { ModuleLogger } from '@stagewise/logger';

import { assembleInferenceInstructions } from '@/session/interaction';

import type { ExtendedUIMessage } from '../message-types';
import type { AgentTools } from '../tools';
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
  modelContext: {
    providerType: string;
    providerId: string;
    modelId: string;
  };
  /** UUID of the session instance — passed to telemetry via runtimeContext. */
  sessionId: string;
  /** Whether the history was compacted by an extension before this generation. */
  compacted: boolean;
  /** Provider-specific options resolved from the model selection entry. */
  providerOptions?: Record<string, JSONObject>;
  /**
   * System prompt parts collected from extensions at the beginning of
   * the step. Appended to the base system prompt (separated by blank
   * lines) before generation.
   */
  extensionSystemPromptParts?: string[];
  /**
   * Base system prompt for this generation. Required — every session
   * must explicitly declare its base prompt.
   */
  basePrompt: string;
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
  params.logger.trace(
    {
      'event.name': 'generation.started',
      generationId: id,
      sessionId: params.sessionId,
      providerType: params.modelContext.providerType,
      modelId: params.modelContext.modelId,
      messageCount: params.modelMessages.length,
    },
    'Generation started',
  );

  let message: ExtendedUIMessage = {
    id: id,
    role: 'assistant',
    parts: [],
  };

  // The AI SDK reports provider failures that occur inside the stream
  // (e.g. a 404 for an unreachable file URI) only through `onError`; the
  // error it throws afterwards is a cause-less NoOutputGeneratedError.
  // Capture the original so the classifier sees the real APICallError.
  let streamError: unknown;

  const result = streamText({
    model: params.model,
    tools: toolsWithoutExecute(params.tools),
    instructions: {
      role: 'system',
      content: assembleInferenceInstructions(
        params.basePrompt,
        params.extensionSystemPromptParts ?? [],
      ),
    },
    telemetry: {
      isEnabled: true,
      functionId: 'chat-session',
      // The AI SDK's restricted telemetry dispatcher strips runtime
      // context keys unless they are explicitly allow-listed here.
      includeRuntimeContext: {
        'conversation.id': true,
        'conversation.compacted': true,
        'conversation.providerType': true,
        'conversation.providerId': true,
        'conversation.modelId': true,
      },
    },
    runtimeContext: {
      'conversation.id': params.sessionId,
      'conversation.compacted': params.compacted,
      'conversation.providerType': params.modelContext.providerType,
      'conversation.providerId': params.modelContext.providerId,
      'conversation.modelId': params.modelContext.modelId,
    },
    abortSignal: params.abortSignal,
    onError: ({ error }) => {
      streamError ??= error;
    },
    maxRetries: 0,
    messages: params.modelMessages,
    ...(params.providerOptions !== undefined && {
      providerOptions: params.providerOptions,
    }),
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

  let finishReason: FinishReason;
  let rawFinishReason: unknown;
  let usage: LanguageModelUsage;
  try {
    for await (const uiMessage of uiMsgUpdateStream) {
      message = uiMessage;
      params.onUpdate?.(uiMessage);
    }

    finishReason = await result.finishReason;
    rawFinishReason = await result.rawFinishReason;
    usage = await result.usage;
  } catch (e) {
    throw attachStreamError(e, streamError);
  }

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

  params.logger.trace(
    {
      'event.name': 'generation.finished',
      generationId: id,
      sessionId: params.sessionId,
      finishReason,
      partCount: message.parts.length,
      hasError: response.error !== undefined,
    },
    'Generation finished',
  );
  return response;
}

/**
 * Re-wraps a cause-less NoOutputGeneratedError with the error captured
 * from the stream, so classification can recurse into the provider error.
 */
export function attachStreamError(
  thrown: unknown,
  streamError: unknown,
): unknown {
  if (
    streamError instanceof Error &&
    NoOutputGeneratedError.isInstance(thrown) &&
    thrown.cause == null
  ) {
    return new NoOutputGeneratedError({
      message: thrown.message,
      cause: streamError,
    });
  }
  return thrown;
}
