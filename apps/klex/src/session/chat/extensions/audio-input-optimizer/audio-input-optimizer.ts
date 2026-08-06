import { createHash } from 'node:crypto';

import {
  type FilePart,
  type ModelMessage,
  type TextPart,
  type ToolSet,
  tool,
} from 'ai';
import z from 'zod';

import type { ModelSelectionEntry } from '@/config';

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
  type EffectiveAudio,
  extractAudioBuffer,
  type ProcessedPart,
  resolveEffectiveAudio,
  runOptimization,
} from './audio-processing';
import audioSystemPrompt from './audio-system-prompt.md';
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

  constructor(private readonly deps: ExtensionDeps) {}

  getTools(model: ResolvedModel): ToolSet {
    // Only expose the listenAudio tool when the active model cannot hear
    // audio. Audio-capable models don't need this tool.
    const settings = resolveEffectiveAudio(model.inputCapabilities);
    if (settings.supports) return {};

    const audioModelIds = resolveAudioModels(this.deps.config);
    if (audioModelIds.length === 0) return {};

    return {
      [LISTEN_AUDIO_TOOL_NAME]: tool({
        description:
          'Get more information about an audio clip that referenced this tool. Only use this tool when an audio placeholder in the conversation instructs you to do so. Pass the audio ID from the placeholder text and specify "lookFor" to focus on specific aspects of the audio.',
        inputSchema: z.object({
          id: z
            .string()
            .describe('The audio ID from the placeholder text (e.g. "0-1")'),
          lookFor: z
            .string()
            .describe(
              'What to specifically listen for in the audio (e.g. "speech content", "music genre", "background sounds")',
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
          const toolAudioModelIds = resolveAudioModels(this.deps.config);

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
    const audioModelIds = resolveAudioModels(this.deps.config);
    const hasAudioModels = !settings.supports && audioModelIds.length > 0;

    // Determine whether the listenAudio tool will be offered to this model.
    // If not, any listenAudio tool calls/results in history must be stripped
    // and inlined as text so the model doesn't see calls to an unknown tool
    // (e.g. after a model fallback to an audio-capable model).
    const shouldStripListenAudioTool = !hasAudioModels;

    const transformed = await Promise.all(
      history.map(async (message, messageIndex) => {
        if (!Array.isArray(message.content)) return message;

        // User messages: process FilePart with audio media types
        if (message.role === 'user') {
          const content = await Promise.all(
            message.content.map(async (part, partIndex) => {
              if (part.type === 'file' && part.mediaType.startsWith('audio')) {
                return this.processAudioPart(
                  part,
                  model.modelId,
                  settings,
                  `${messageIndex}-${partIndex}`,
                  hasAudioModels,
                  audioModelIds,
                );
              }
              return part;
            }),
          );
          return { ...message, content };
        }

        // Assistant messages: process FilePart with audio media types
        if (message.role === 'assistant') {
          const content = await Promise.all(
            message.content.map(async (part, partIndex) => {
              if (part.type === 'file' && part.mediaType.startsWith('audio')) {
                return this.processAudioPart(
                  part,
                  model.modelId,
                  settings,
                  `${messageIndex}-${partIndex}`,
                  hasAudioModels,
                  audioModelIds,
                ) as unknown as typeof part;
              }
              return part;
            }),
          );
          return { ...message, content };
        }

        // Tool messages: process audio file items inside tool-result outputs
        if (message.role === 'tool') {
          const content = await Promise.all(
            message.content.map(async (part, partIndex) => {
              if (part.type !== 'tool-result') return part;
              const output = part.output;
              if (
                !output ||
                typeof output !== 'object' ||
                output.type !== 'content' ||
                !Array.isArray(output.value)
              ) {
                return part;
              }
              const newValue = await Promise.all(
                output.value.map(async (item, valueIndex) => {
                  if (
                    item &&
                    typeof item === 'object' &&
                    item.type === 'file' &&
                    typeof item.mediaType === 'string' &&
                    item.mediaType.startsWith('audio')
                  ) {
                    return this.processAudioPart(
                      item as FilePart,
                      model.modelId,
                      settings,
                      `${messageIndex}-${partIndex}-${valueIndex}`,
                      hasAudioModels,
                      audioModelIds,
                    ) as unknown as typeof item;
                  }
                  return item;
                }),
              );
              return {
                ...part,
                output: { ...output, value: newValue } as typeof output,
              };
            }),
          );
          return { ...message, content };
        }

        return message;
      }),
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

  private async processAudioPart(
    part: FilePart,
    modelId: string,
    settings: EffectiveAudio,
    audioId: string,
    hasAudioModels: boolean,
    audioModelIds: readonly ModelSelectionEntry[],
  ): Promise<ProcessedPart> {
    const buffer = extractAudioBuffer(part);

    // supports === false: replace with description or fallback text
    if (!settings.supports) {
      if (hasAudioModels) {
        const id = audioId;
        this.audioRegistry.set(id, part);

        if (buffer === null) {
          // URL/reference audio — can't extract inline data to
          // generate a general description. Still register it so the
          // listenAudio tool can attempt to analyze it on-demand.
          return {
            type: 'text',
            text: `Can't directly hear audio. Use tool '${LISTEN_AUDIO_TOOL_NAME}' with ID ${id} to get information on audio content.`,
          };
        }

        // Generate a general description of the audio. This is cached
        // by audio hash (no lookFor) and shared across all non-audio
        // models, so it is only generated once per unique audio.
        const audioHash = createHash('sha1')
          .update(buffer)
          .digest('hex')
          .slice(0, 16);
        const description = await describeAudio(
          this.deps,
          part,
          audioModelIds,
          buffer,
          audioHash,
          undefined,
          audioSystemPrompt,
        );
        if (description !== null) {
          return {
            type: 'text',
            text: `${description}\n\nFor more specific details about this audio, use the '${LISTEN_AUDIO_TOOL_NAME}' tool with ID ${id}.`,
          };
        }
        // Audio model call failed — still offer the tool so the model
        // can retry on-demand.
        return {
          type: 'text',
          text: `Can't directly hear audio. Use tool '${LISTEN_AUDIO_TOOL_NAME}' with ID ${id} to get information on audio content.`,
        };
      }
      return { type: 'text', text: UNSUPPORTED_AUDIO_TEXT };
    }

    // supports === true: pass through URL/reference audio uncached
    if (buffer === null) return part;

    // supports === true: process audio (format conversion, etc.) with caching
    const cacheKey = `${createHash('sha1').update(buffer).digest('hex').slice(0, 16)}:${modelId}`;
    const cached = cache.get(cacheKey);
    if (cached !== undefined) return cached;

    try {
      const filePart = await runOptimization(buffer, part, settings);
      cache.set(cacheKey, filePart);
      return filePart;
    } catch (error) {
      // Graceful degradation: log and replace with text notification
      this.deps.logger.error({ error }, 'Failed to process audio');
      const textPart: TextPart = {
        type: 'text',
        text: UNSUPPORTED_AUDIO_TEXT,
      };
      cache.set(cacheKey, textPart);
      return textPart;
    }
  }
}

export const createAudioInputOptimizerExt: ExtensionFactory = {
  identifier: AUDIO_INPUT_OPTIMIZER_IDENTIFIER,
  displayName: 'Audio Input Optimizer',
  create: (deps) => new AudioInputOptimizerExt(deps),
};
