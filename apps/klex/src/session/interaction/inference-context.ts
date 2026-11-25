import type { ModelMessage, ToolSet } from 'ai';

import { isCheckpointHeader } from '@/session/chat/checkpoint';
import type { ExtensionHandler } from '@/session/chat/extension-handler';
import type {
  ResolvedModel,
  TransformationFlags,
} from '@/session/chat/extensions/extension-api';
import type { ExtendedUIMessage } from '@/session/chat/message-types';
import { convertToModelMessagesExtended } from '@/session/chat/utils/convert-to-model-messages';
import {
  field,
  LINES_FORMAT_PROMPT,
  renderDataBlock,
} from '@/session/chat/utils/history-view';

import type { InteractionLeaseRequest } from './types';

export interface AssembledInferenceContext {
  readonly messages: ModelMessage[];
  readonly tools: ToolSet;
  readonly instructions: string;
  readonly flags: TransformationFlags;
}

/** Append call-local data after transformers, without changing canonical history. */
export function appendExternalInteractionContext(
  messages: readonly ModelMessage[],
  request: Pick<
    InteractionLeaseRequest,
    'namespace' | 'externalSessionId' | 'externalContext'
  >,
): ModelMessage[] {
  const context = request.externalContext;
  if (
    !context ||
    ((!context.text || context.text.trim().length === 0) &&
      Object.keys(context.metadata ?? {}).length === 0)
  )
    return [...messages];
  const provenance = (value: string) =>
    value.length <= 256 ? value : `${value.slice(0, 256)}[truncated]`;
  const envelope = JSON.stringify({
    source: {
      namespace: provenance(request.namespace),
      sessionId: provenance(request.externalSessionId),
    },
    context,
  }).replace(
    /[\u0085\u2028\u2029]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  return [
    ...messages,
    {
      role: 'user',
      content: renderDataBlock({
        type: 'realtime-context',
        fields: [field('context', envelope)],
      }),
    },
  ];
}

/** Assembles the base prompt and extension contributions. */
export function assembleInferenceInstructions(
  baseInstructions: string,
  parts: readonly string[],
): string {
  return [
    baseInstructions,
    ...(baseInstructions.includes(LINES_FORMAT_PROMPT)
      ? []
      : [LINES_FORMAT_PROMPT]),
    ...parts,
  ]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join('\n\n');
}

export async function runInferenceHistoryTransformers(
  handler: ExtensionHandler,
  history: ExtendedUIMessage[],
  model: ResolvedModel,
): Promise<{ history: ExtendedUIMessage[]; flags: TransformationFlags }> {
  // A checkpoint header at the window start means older history was
  // replaced by a summary; read it before transformers can reshape the view.
  const startsWithCheckpoint = isCheckpointHeader(history[0]);
  const result = await handler.runHistoryTransformers(history, model);
  if (!startsWithCheckpoint) return result;
  return { ...result, flags: { ...result.flags, hasCompacted: true } };
}

export async function convertInferenceHistory(
  handler: ExtensionHandler,
  history: ExtendedUIMessage[],
  onMemoryMetrics?: Parameters<typeof convertToModelMessagesExtended>[2],
  projectContext?: Parameters<typeof convertToModelMessagesExtended>[3],
): Promise<ModelMessage[]> {
  return convertToModelMessagesExtended(
    history,
    handler.getDataPartTransformers(),
    onMemoryMetrics,
    projectContext,
  );
}

export async function runInferenceContextTransformers(
  handler: ExtensionHandler,
  history: ModelMessage[],
  model: ResolvedModel,
): Promise<{ history: ModelMessage[]; flags: TransformationFlags }> {
  return handler.runContextTransformers(history, model);
}

export async function assembleInferenceContext(options: {
  history: readonly ExtendedUIMessage[];
  extensionHandler: ExtensionHandler;
  model: ResolvedModel;
  baseInstructions: string;
  projectContext?: Parameters<typeof convertToModelMessagesExtended>[3];
  onMemoryMetrics?: Parameters<typeof convertToModelMessagesExtended>[2];
}): Promise<AssembledInferenceContext> {
  const historyResult = await runInferenceHistoryTransformers(
    options.extensionHandler,
    [...structuredClone(options.history)],
    options.model,
  );
  const converted = await convertInferenceHistory(
    options.extensionHandler,
    historyResult.history,
    options.onMemoryMetrics,
    options.projectContext,
  );
  const contextResult = await runInferenceContextTransformers(
    options.extensionHandler,
    converted,
    options.model,
  );
  return {
    messages: contextResult.history,
    tools: options.extensionHandler.getTools(options.model),
    instructions: assembleInferenceInstructions(
      options.baseInstructions,
      options.extensionHandler.getSystemPromptParts(),
    ),
    flags: {
      hasCompacted:
        historyResult.flags.hasCompacted === true ||
        contextResult.flags.hasCompacted === true,
    },
  };
}
