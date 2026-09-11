import type { ModelMessage, ToolSet } from 'ai';

import type { ExtensionHandler } from '@/session/chat/extension-handler';
import type {
  ResolvedModel,
  TransformationFlags,
} from '@/session/chat/extensions/extension-api';
import type { ExtendedUIMessage } from '@/session/chat/message-types';
import { convertToModelMessagesExtended } from '@/session/chat/utils/convert-to-model-messages';

export interface AssembledInferenceContext {
  readonly messages: ModelMessage[];
  readonly tools: ToolSet;
  readonly instructions: string;
  readonly flags: TransformationFlags;
}

export function assembleInferenceInstructions(
  baseInstructions: string,
  parts: readonly string[],
): string {
  return [baseInstructions, ...parts]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join('\n\n');
}

export async function runInferenceHistoryTransformers(
  handler: ExtensionHandler,
  history: ExtendedUIMessage[],
  model: ResolvedModel,
): Promise<{ history: ExtendedUIMessage[]; flags: TransformationFlags }> {
  return handler.runHistoryTransformers(history, model);
}

export async function convertInferenceHistory(
  handler: ExtensionHandler,
  history: ExtendedUIMessage[],
): Promise<ModelMessage[]> {
  return convertToModelMessagesExtended(
    history,
    handler.getDataPartTransformers(),
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
}): Promise<AssembledInferenceContext> {
  const historyResult = await runInferenceHistoryTransformers(
    options.extensionHandler,
    [...structuredClone(options.history)],
    options.model,
  );
  const converted = await convertInferenceHistory(
    options.extensionHandler,
    historyResult.history,
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
