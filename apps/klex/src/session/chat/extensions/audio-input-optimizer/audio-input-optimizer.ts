import { createHash } from 'node:crypto';

import { type FilePart, type ModelMessage, type ToolSet, tool } from 'ai';
import z from 'zod';

import { adaptAudioContent } from '../content-adaptation/content-adaptation';
import type {
  ContextProcessingResult,
  Extension,
  ExtensionDeps,
  ExtensionFactory,
  ResolvedModel,
} from '../extension-api';
import {
  describeAudio,
  LISTEN_AUDIO_TOOL_NAME,
  resolveAudioModels,
  stripListenAudioFromHistory,
  UNSUPPORTED_AUDIO_TEXT,
} from './audio-helper';
import {
  cache,
  descriptionCache,
  extractAudioBuffer,
  isFfmpegAvailable,
  resolveEffectiveAudio,
} from './audio-processing';
import audioToolPrompt from './audio-tool-system-prompt.md';

export {
  BoundedCache,
  clearAudioInputOptimizerCache,
} from './audio-processing';

export const AUDIO_INPUT_OPTIMIZER_IDENTIFIER =
  'io.stagewise/audio-input-optimizer';

class AudioInputOptimizerExt implements Extension {
  /**
   * Maps audio IDs to their original parts, rebuilt on each context
   * transformation so the listenAudio tool can access audio by ID.
   */
  private readonly audioRegistry = new Map<string, FilePart>();

  constructor(private readonly deps: ExtensionDeps) {
    if (!isFfmpegAvailable()) {
      deps.logger.warn(
        'bundled ffprobe binary failed to execute — audio input optimizer will degrade to text replacement for all audio',
      );
    }
  }

  getTools(model: ResolvedModel): ToolSet {
    // Only expose the listenAudio tool when the active model cannot hear
    // audio. Audio-capable models don't need this tool.
    const settings = resolveEffectiveAudio(model.inputCapabilities);
    if (settings.supports) return {};

    const audioModelIds = resolveAudioModels(this.deps);
    if (audioModelIds.length === 0) return {};

    return {
      [LISTEN_AUDIO_TOOL_NAME]: tool({
        description:
          'Inspect referenced audio. Use only for an audio placeholder. Pass its ID and a focus.',
        inputSchema: z.object({
          id: z.string().describe('Placeholder audio ID, e.g. "0-1".'),
          lookFor: z
            .string()
            .describe(
              'What to hear for, e.g. speech, music genre, or background sounds.',
            ),
        }),
        execute: async ({ id, lookFor }) => {
          const audioPart = this.audioRegistry.get(id);
          if (audioPart === undefined) {
            return `Audio with ID "${id}" not found. It may have been from a previous conversation turn.`;
          }

          const toolBuffer = extractAudioBuffer(audioPart);
          const toolAudioHash = toolBuffer
            ? createHash('sha1').update(toolBuffer).digest('hex').slice(0, 16)
            : null;
          const toolAudioModelIds = resolveAudioModels(this.deps);

          const description = await describeAudio(
            this.deps,
            audioPart,
            toolAudioModelIds,
            toolBuffer,
            toolAudioHash,
            lookFor,
            audioToolPrompt,
          );
          if (description !== null) return description;

          return 'Unable to analyze this audio. The audio model could not process it.';
        },
      }),
    };
  }

  async contextTransformer(
    history: ModelMessage[],
    model: ResolvedModel,
  ): Promise<ContextProcessingResult> {
    const settings = resolveEffectiveAudio(model.inputCapabilities);

    // Clear the audio registry at the start of each context transformation
    // so IDs from the previous step don't linger.
    this.audioRegistry.clear();

    // Pre-compute audio model availability for the non-audio path.
    const audioModelIds = resolveAudioModels(this.deps);
    const hasAudioModels = !settings.supports && audioModelIds.length > 0;

    // Determine whether the listenAudio tool will be offered to this model.
    // If not, any listenAudio tool calls/results in history must be stripped
    // and inlined as text so the model doesn't see calls to an unknown tool
    // (e.g. after a model fallback to an audio-capable model).
    const shouldStripListenAudioTool = !hasAudioModels;

    const transformed = await adaptAudioContent(
      history,
      this.deps,
      model,
      (part, adapted, id) => {
        if (!hasAudioModels) return adapted;
        this.audioRegistry.set(id, part);
        if (adapted.type !== 'text') return adapted;
        const hint = `Can't directly hear audio. Use tool '${LISTEN_AUDIO_TOOL_NAME}' with ID ${id} to get information on audio content.`;
        return {
          ...adapted,
          text:
            adapted.text === UNSUPPORTED_AUDIO_TEXT
              ? hint
              : `${adapted.text}\n\nFor more specific details about this audio, use the '${LISTEN_AUDIO_TOOL_NAME}' tool with ID ${id}.`,
        };
      },
      false,
    );

    if (!shouldStripListenAudioTool) return transformed;

    return stripListenAudioFromHistory(transformed);
  }

  introspect(): Record<string, unknown> {
    return {
      cacheSize: cache.size,
      descriptionCacheSize: descriptionCache.size,
      registeredAudio: this.audioRegistry.size,
    };
  }
}
/** Converts audio input into model-compatible content or a text fallback. */
export const createAudioInputOptimizerExt: ExtensionFactory = {
  identifier: AUDIO_INPUT_OPTIMIZER_IDENTIFIER,
  displayName: 'Audio Input Optimizer',
  create: (deps) => new AudioInputOptimizerExt(deps),
};
