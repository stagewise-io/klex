import type { FilePart, ModelMessage, TextPart } from 'ai';

import type { ModelSelectionEntry } from '@/config';
import { extractToolResultText } from '@/shared-utilities';

import type { ExtensionDeps } from '../extension-api';
import {
  cache,
  descriptionCache,
  type EffectiveAudio,
  extractAudioBuffer,
  inflightDescriptions,
  resolveEffectiveAudio,
  runOptimization,
} from './audio-processing';

export const LISTEN_AUDIO_TOOL_NAME = 'listenAudio';

export const UNSUPPORTED_AUDIO_TEXT =
  "Can't hear this audio. Audio input isn't supported.";

/**
 * Resolves the configured audio-vision helper models, filtering to only
 * those whose metadata confirms audio input capability. Models that fail
 * to resolve (e.g. broken provider references) are silently excluded.
 */
export function resolveAudioModels(
  deps: Pick<ExtensionDeps, 'config' | 'modelResolver'>,
): readonly ModelSelectionEntry[] {
  const entries = deps.config.getModelSelection('audioListening');
  return entries.filter((entry) => {
    try {
      const info = deps.modelResolver.resolveModelInfo(entry);
      return info.inputCapabilities?.audio !== undefined;
    } catch {
      return false;
    }
  });
}

/**
 * Optimizes an audio part for the first configured audio helper
 * model's input capabilities. Uses the same optimization pipeline
 * as the main audio processing path (format conversion, size
 * reduction). Failed optimization skips the candidate rather than sending
 * audio that may violate its limits. References remain provider-managed.
 */
export async function optimizeForAudioHelper(
  deps: ExtensionDeps,
  part: FilePart,
  buffer: Buffer | null,
  audioModelIds: readonly ModelSelectionEntry[],
  audioHash: string | null,
): Promise<FilePart | null> {
  if (buffer === null || !audioHash) return part;
  if (audioModelIds.length === 0) return part;

  const firstEntry = audioModelIds[0];
  if (!firstEntry) return part;
  const audioModelId = firstEntry.modelId;
  let settings: EffectiveAudio;
  try {
    const info = deps.modelResolver.resolveModelInfo(firstEntry);
    settings = resolveEffectiveAudio(info.inputCapabilities);
  } catch {
    return null;
  }

  if (!settings.supports) return null;

  const cacheKey = `${audioHash}:${firstEntry.providerId}:${audioModelId}:${JSON.stringify(settings)}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined && cached.type !== 'text') return cached;

  try {
    const filePart = await runOptimization(buffer, part, settings);
    cache.set(cacheKey, filePart);
    return filePart;
  } catch (error) {
    deps.logger.error({ error }, 'Failed to optimize audio for audio model');
    return null;
  }
}

/**
 * Calls an audio-capable model to produce a textual description of
 * the audio. Falls back to chat models with audio capability if all
 * audio-vision models fail. Returns null if all attempts fail. General
 * descriptions (no lookFor) are cached by audio hash so they are not
 * regenerated on every step. Targeted descriptions (with lookFor) are
 * not cached — their results live in the chat history as tool results.
 */
export async function describeAudio(
  deps: ExtensionDeps,
  audioPart: FilePart,
  audioModelIds: readonly ModelSelectionEntry[],
  buffer: Buffer | null,
  audioHash: string | null,
  lookFor: string | undefined,
  systemPrompt: string,
): Promise<string | null> {
  // Only deduplicate general descriptions (no lookFor). Targeted
  // descriptions from the listenAudio tool are not cached here — their
  // results live in the chat history as tool results.
  if (audioHash && !lookFor) {
    const cached = descriptionCache.get(audioHash);
    if (cached !== undefined) return cached;

    const inflight = inflightDescriptions.get(audioHash);
    if (inflight) return inflight;
  }

  const promise = runDescribeAudio(
    deps,
    audioPart,
    audioModelIds,
    buffer,
    audioHash,
    lookFor,
    systemPrompt,
  );

  if (audioHash && !lookFor) {
    inflightDescriptions.set(audioHash, promise);
    void promise.then(
      () => inflightDescriptions.delete(audioHash),
      () => inflightDescriptions.delete(audioHash),
    );
  }

  return promise;
}

async function runDescribeAudio(
  deps: ExtensionDeps,
  audioPart: FilePart,
  audioModelIds: readonly ModelSelectionEntry[],
  buffer: Buffer | null,
  audioHash: string | null,
  lookFor: string | undefined,
  systemPrompt: string,
): Promise<string | null> {
  const chatEntries = deps.config.getModelSelection('chat').filter((entry) => {
    try {
      return (
        deps.modelResolver.resolveModelInfo(entry).inputCapabilities?.audio !==
        undefined
      );
    } catch {
      return false;
    }
  });
  // Re-project from the original for every helper candidate, including chat fallback.
  for (const entry of [...audioModelIds, ...chatEntries]) {
    const optimizedPart = await optimizeForAudioHelper(
      deps,
      audioPart,
      buffer,
      [entry],
      audioHash,
    );
    if (optimizedPart === null) continue;
    const userContent: Array<FilePart | TextPart> = [optimizedPart];
    if (lookFor)
      userContent.push({
        type: 'text',
        text: `Specifically listen for: ${lookFor}`,
      });
    const result = await deps.generateText({
      modelIds: [entry],
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    });
    if (result.success) {
      if (audioHash && !lookFor) descriptionCache.set(audioHash, result.text);
      return result.text;
    }
    if (result.failureReason === 'aborted') return null;
  }
  return null;
}

/**
 * Strips listenAudio tool-call and tool-result parts from the history.
 * Tool results are inlined as text into the assistant message where the
 * tool-call originated, and the corresponding tool-result parts are
 * removed from tool messages. Tool messages that become empty are
 * dropped entirely. This prevents a model that doesn't have the
 * listenAudio tool from seeing calls to an unknown tool (e.g. after a
 * model fallback to an audio-capable model).
 */
export function stripListenAudioFromHistory(
  history: ModelMessage[],
): ModelMessage[] {
  // Collect listenAudio tool results by toolCallId so we can inline them
  // into the assistant messages where the tool-calls originated.
  const listenAudioResults = new Map<string, string>();
  for (const msg of history) {
    if (msg.role === 'tool' && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (
          part.type === 'tool-result' &&
          part.toolName === LISTEN_AUDIO_TOOL_NAME
        ) {
          listenAudioResults.set(part.toolCallId, extractToolResultText(part));
        }
      }
    }
  }

  if (listenAudioResults.size === 0) return history;

  return history
    .map((msg): ModelMessage | null => {
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        const content = msg.content.map((part) => {
          if (
            part.type === 'tool-call' &&
            part.toolName === LISTEN_AUDIO_TOOL_NAME
          ) {
            const resultText = listenAudioResults.get(part.toolCallId) ?? '';
            return {
              type: 'text' as const,
              text: `[listenAudio result: ${resultText}]`,
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
            part.toolName !== LISTEN_AUDIO_TOOL_NAME,
        );
        if (content.length === 0) {
          // All results were listenAudio — already inlined into the
          // preceding assistant message. Drop this empty tool message.
          return null;
        }
        return { ...msg, content };
      }

      return msg;
    })
    .filter((msg): msg is ModelMessage => msg !== null);
}

// Re-export for use by the main module
export { extractAudioBuffer };
