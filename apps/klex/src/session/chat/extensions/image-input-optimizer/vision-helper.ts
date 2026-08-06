import type {
  FilePart,
  ImagePart,
  ModelMessage,
  TextPart,
  ToolResultPart,
} from 'ai';

import type { ModelSelectionEntry } from '@/config';
import { modelIdFromEntry } from '@/config';

import type { ExtensionDeps } from '../extension-api';
import {
  cache,
  descriptionCache,
  type EffectiveVision,
  resolveEffectiveVision,
  runOptimization,
} from './image-processing';

export const VIEW_IMAGE_TOOL_NAME = 'viewImage';

export const UNSUPPORTED_IMAGE_TEXT =
  "Can't see the image, you have no vision capabilities or vision model as a helper to see the image.";

/**
 * Resolves the configured image-vision helper models, filtering to only
 * those whose metadata confirms image input capability. Models that fail
 * to resolve (e.g. broken provider references) are silently excluded.
 */
export function resolveVisionModels(
  config: ExtensionDeps['config'],
): readonly ModelSelectionEntry[] {
  const entries = config.getModelSelection('imageVision');
  return entries.filter((entry) => {
    try {
      const info = config.resolveModelInfo(entry);
      return info.inputCapabilities?.image !== undefined;
    } catch {
      return false;
    }
  });
}

/**
 * Optimizes an image part for the first configured vision helper
 * model's input capabilities. Uses the same optimization pipeline
 * as the main image processing path (resize, format conversion,
 * metadata stripping, data-size reduction). Falls back to the
 * original part if no vision models are configured, the model
 * can't be resolved, or optimization fails.
 */
export async function optimizeForVisionHelper(
  deps: ExtensionDeps,
  part: FilePart | ImagePart,
  buffer: Buffer | null,
  visionModelIds: readonly ModelSelectionEntry[],
  imageHash: string | null,
): Promise<FilePart | ImagePart> {
  if (buffer === null || !imageHash) return part;
  if (visionModelIds.length === 0) return part;

  const firstEntry = visionModelIds[0];
  if (!firstEntry) return part;
  const visionModelId = modelIdFromEntry(firstEntry);
  let settings: EffectiveVision;
  try {
    const info = deps.config.resolveModelInfo(firstEntry);
    settings = resolveEffectiveVision(info.inputCapabilities);
  } catch {
    return part;
  }

  if (!settings.supports) return part;

  const cacheKey = `${imageHash}:${visionModelId}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined && cached.type !== 'text') return cached;

  try {
    const filePart = await runOptimization(buffer, part, settings);
    cache.set(cacheKey, filePart);
    return filePart;
  } catch (error) {
    deps.logger.error({ error }, 'Failed to optimize image for vision model');
    return part; // Return original — vision model may still handle it
  }
}

/**
 * Calls a vision-capable model to produce a textual description of
 * the image. Falls back to chat models with image capability if all
 * vision models fail. Returns null if all attempts fail. General
 * descriptions (no lookFor) are cached by image hash so they are not
 * regenerated on every step. Targeted descriptions (with lookFor) are
 * not cached — their results live in the chat history as tool results.
 */
export async function describeImage(
  deps: ExtensionDeps,
  imagePart: FilePart | ImagePart,
  visionModelIds: readonly ModelSelectionEntry[],
  buffer: Buffer | null,
  imageHash: string | null,
  lookFor: string | undefined,
  systemPrompt: string,
): Promise<string | null> {
  // Only cache general descriptions (no lookFor). Targeted descriptions
  // from the viewImage tool are stored as tool results in the chat
  // history, so re-caching them here is unnecessary.
  if (imageHash && !lookFor) {
    const cached = descriptionCache.get(imageHash);
    if (cached !== undefined) return cached;
  }

  // Optimize the image for the vision helper model's capabilities
  // before sending it — same pipeline as regular image processing.
  const optimizedPart = await optimizeForVisionHelper(
    deps,
    imagePart,
    buffer,
    visionModelIds,
    imageHash,
  );

  const userContent: Array<FilePart | ImagePart | TextPart> = [optimizedPart];
  if (lookFor) {
    userContent.push({
      type: 'text',
      text: `Specifically look for: ${lookFor}`,
    });
  }
  const messages: ModelMessage[] = [{ role: 'user', content: userContent }];

  const result = await deps.generateText({
    modelIds: visionModelIds,
    system: systemPrompt,
    messages,
  });

  if (result.success) {
    if (imageHash && !lookFor) descriptionCache.set(imageHash, result.text);
    return result.text;
  }

  // Fallback: try chat models with image capability
  const chatEntries = deps.config.getModelSelection('chat');
  const visionChatEntries = chatEntries.filter((entry) => {
    try {
      const info = deps.config.resolveModelInfo(entry);
      return info.inputCapabilities?.image !== undefined;
    } catch {
      return false;
    }
  });

  if (visionChatEntries.length > 0) {
    deps.logger.warn(
      'All vision models failed — falling back to chat models with image capability',
    );
    const fallbackResult = await deps.generateText({
      modelIds: visionChatEntries,
      system: systemPrompt,
      messages,
    });

    if (fallbackResult.success) {
      if (imageHash && !lookFor)
        descriptionCache.set(imageHash, fallbackResult.text);
      return fallbackResult.text;
    }
  }

  return null;
}

/**
 * Strips viewImage tool-call and tool-result parts from the history.
 * Tool results are inlined as text into the assistant message where the
 * tool-call originated, and the corresponding tool-result parts are
 * removed from tool messages. Tool messages that become empty are
 * dropped entirely. This prevents a model that doesn't have the
 * viewImage tool from seeing calls to an unknown tool (e.g. after a
 * model fallback to a vision-capable model).
 */
export function stripViewImageFromHistory(
  history: ModelMessage[],
): ModelMessage[] {
  // Collect viewImage tool results by toolCallId so we can inline them
  // into the assistant messages where the tool-calls originated.
  const viewImageResults = new Map<string, string>();
  for (const msg of history) {
    if (msg.role === 'tool' && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (
          part.type === 'tool-result' &&
          part.toolName === VIEW_IMAGE_TOOL_NAME
        ) {
          viewImageResults.set(part.toolCallId, extractToolResultText(part));
        }
      }
    }
  }

  if (viewImageResults.size === 0) return history;

  return history
    .map((msg): ModelMessage | null => {
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        const content = msg.content.map((part) => {
          if (
            part.type === 'tool-call' &&
            part.toolName === VIEW_IMAGE_TOOL_NAME
          ) {
            const resultText = viewImageResults.get(part.toolCallId) ?? '';
            return {
              type: 'text' as const,
              text: `[viewImage result: ${resultText}]`,
            } satisfies TextPart;
          }
          return part;
        });
        return { ...msg, content };
      }

      if (msg.role === 'tool' && Array.isArray(msg.content)) {
        const content = msg.content.filter(
          (part) =>
            part.type !== 'tool-result' ||
            part.toolName !== VIEW_IMAGE_TOOL_NAME,
        );
        if (content.length === 0) {
          // All results were viewImage — already inlined into the
          // preceding assistant message. Drop this empty tool message.
          return null;
        }
        return { ...msg, content };
      }

      return msg;
    })
    .filter((msg): msg is ModelMessage => msg !== null);
}

/** Extracts a text string from a ToolResultPart's output field. */
function extractToolResultText(part: ToolResultPart): string {
  const output = part.output;
  if (typeof output === 'string') return output;
  if (output && typeof output === 'object') {
    if (output.type === 'text') return output.value as string;
    if (output.type === 'error-text') return output.value as string;
    if (output.type === 'json') return JSON.stringify(output.value);
    if (output.type === 'content' && Array.isArray(output.value)) {
      return output.value
        .map((p: { type: string; text?: string }) =>
          p.type === 'text' ? p.text : '',
        )
        .join('');
    }
  }
  return '';
}
