import { createHash } from 'node:crypto';

import type { FilePart, ImagePart, ModelMessage, TextPart } from 'ai';

import { describeMediaContent } from '@/shared-utilities/tool-result';

import {
  describeAudio,
  resolveAudioModels,
  UNSUPPORTED_AUDIO_TEXT,
} from '../audio-input-optimizer/audio-helper';
import {
  cache,
  extractAudioBuffer,
  type ProcessedPart,
  resolveEffectiveAudio,
  runOptimization,
} from '../audio-input-optimizer/audio-processing';
import audioSystemPrompt from '../audio-input-optimizer/audio-system-prompt.md';
import type { ExtensionDeps, ResolvedModel } from '../extension-api';
import {
  extractImageBuffer,
  runOptimization as optimizeImage,
  resolveEffectiveVision,
} from '../image-input-optimizer/image-processing';
import {
  describeImage,
  resolveVisionModels,
  UNSUPPORTED_IMAGE_TEXT,
} from '../image-input-optimizer/vision-helper';
import visionSystemPrompt from '../image-input-optimizer/vision-system-prompt.md';
import { projectToolMedia } from './media-projection';

/** Media-only projections can use this entry point without interactive tool policy. */
export async function adaptContent(
  history: readonly ModelMessage[],
  deps: ExtensionDeps,
  model: Pick<ResolvedModel, 'modelId' | 'inputCapabilities'>,
): Promise<ModelMessage[]> {
  let aborted = false;
  const trackedDeps: ExtensionDeps = {
    ...deps,
    generateText: async (args) => {
      if (aborted) return { success: false, failureReason: 'aborted' };
      const result = await deps.generateText(args);
      if (!result.success && result.failureReason === 'aborted') aborted = true;
      return result;
    },
  };
  const audio = await adaptAudioContent(history, trackedDeps, model);
  if (aborted)
    throw new Error('Media adaptation aborted', { cause: 'aborted' });
  return Promise.all(
    audio.map(async (message) => {
      if (message.role !== 'user' || !Array.isArray(message.content))
        return message;
      const content = await Promise.all(
        message.content.map(async (part) => {
          // A checkpoint must not discard audio that no candidate could hear.
          // Interactive callers use adaptAudioContent and can retry via their tool.
          if (part.type === 'text' && part.text === UNSUPPORTED_AUDIO_TEXT) {
            if (aborted)
              throw new Error('Media adaptation aborted', { cause: 'aborted' });
            throw new Error('Audio could not be adapted for compaction');
          }
          if (part.type !== 'image' && part.type !== 'file') return part;
          if (part.type === 'file' && part.mediaType.startsWith('audio/'))
            return part;
          if (part.type === 'file' && !part.mediaType.startsWith('image/')) {
            return { type: 'text' as const, text: describeMediaContent(part) };
          }
          const adapted = await adaptImagePart(part, trackedDeps, model);
          if (
            adapted.type === 'text' &&
            adapted.text === UNSUPPORTED_IMAGE_TEXT
          ) {
            if (aborted)
              throw new Error('Media adaptation aborted', { cause: 'aborted' });
            throw new Error('Image could not be adapted for compaction');
          }
          return adapted;
        }),
      );
      return { ...message, content };
    }),
  );
}

async function adaptImagePart(
  part: FilePart | ImagePart,
  deps: ExtensionDeps,
  model: Pick<ResolvedModel, 'inputCapabilities'>,
): Promise<FilePart | ImagePart | TextPart> {
  const settings = resolveEffectiveVision(model.inputCapabilities);
  const buffer = extractImageBuffer(part);
  if (settings.supports) {
    if (!buffer) return { ...part };
    try {
      return await optimizeImage(buffer, part, settings);
    } catch (error) {
      deps.logger.warn({ error }, 'Could not adapt image');
    }
  } else {
    const hash = buffer
      ? createHash('sha1').update(buffer).digest('hex').slice(0, 16)
      : null;
    const helpers = resolveVisionModels(deps);
    const description = helpers.length
      ? await describeImage(
          deps,
          part,
          helpers,
          buffer,
          hash,
          undefined,
          visionSystemPrompt,
        )
      : null;
    if (description !== null)
      return {
        type: 'text',
        text: `<derived-content source="image" kind="description">\n${description}\n</derived-content>`,
      };
  }
  return { type: 'text', text: UNSUPPORTED_IMAGE_TEXT };
}

/** A target projection. Neither source parts nor canonical history are modified. */
export async function adaptAudioPart(
  deps: ExtensionDeps,
  part: FilePart,
  model: Pick<ResolvedModel, 'modelId' | 'inputCapabilities'>,
  describeReferences = true,
): Promise<ProcessedPart> {
  const settings = resolveEffectiveAudio(model.inputCapabilities);
  const buffer = extractAudioBuffer(part);
  const hash = buffer
    ? createHash('sha1').update(buffer).digest('hex').slice(0, 16)
    : null;
  if (!settings.supports) {
    if (!buffer && !describeReferences)
      return { type: 'text', text: UNSUPPORTED_AUDIO_TEXT };
    const helpers = resolveAudioModels(deps);
    const description =
      helpers.length > 0
        ? await describeAudio(
            deps,
            part,
            helpers,
            buffer,
            hash,
            undefined,
            audioSystemPrompt,
          )
        : null;
    if (description !== null)
      return {
        type: 'text',
        text: `<derived-content source="audio" kind="transcription-description">\n${description}\n</derived-content>`,
      };
    return { type: 'text', text: UNSUPPORTED_AUDIO_TEXT };
  }
  if (buffer === null) return { ...part };
  // Include capabilities: a provider override can change limits for the same model ID.
  const key = `${hash}:${model.modelId}:${JSON.stringify(settings)}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  try {
    const optimized = await runOptimization(buffer, part, settings);
    cache.set(key, optimized);
    return optimized;
  } catch (error) {
    deps.logger.error({ error }, 'Failed to process audio');
    const fallback: TextPart = { type: 'text', text: UNSUPPORTED_AUDIO_TEXT };
    cache.set(key, fallback);
    return fallback;
  }
}

/** Shared traversal; callers own tool registration and any interactive hints. */
export async function adaptAudioContent(
  history: readonly ModelMessage[],
  deps: ExtensionDeps,
  model: Pick<ResolvedModel, 'modelId' | 'inputCapabilities'>,
  decorate?: (
    original: FilePart,
    adapted: ProcessedPart,
    id: string,
  ) => ProcessedPart,
  describeReferences = true,
): Promise<ModelMessage[]> {
  const process = async (part: FilePart, id: string) => {
    const adapted = await adaptAudioPart(deps, part, model, describeReferences);
    return decorate ? decorate(part, adapted, id) : adapted;
  };
  return Promise.all(
    history.map(async (message, messageIndex) => {
      if (!Array.isArray(message.content)) return message;

      // User messages: process FilePart with audio media types
      if (message.role === 'user') {
        const content = await Promise.all(
          message.content.map(async (part, partIndex) => {
            if (part.type === 'file' && part.mediaType.startsWith('audio')) {
              return process(part, `${messageIndex}-${partIndex}`);
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
              return process(
                part,
                `${messageIndex}-${partIndex}`,
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
                const audio = projectToolMedia(item);
                if (
                  audio?.type !== 'file' ||
                  !audio.mediaType.startsWith('audio/')
                )
                  return item;
                const adapted = await process(
                  audio,
                  `${messageIndex}-${partIndex}-${valueIndex}`,
                );
                if (adapted.type === 'text') return adapted;
                if (item.type === 'file')
                  return adapted as unknown as typeof item;
                const buffer = extractAudioBuffer(adapted);
                return buffer
                  ? {
                      type: 'file-data' as const,
                      mediaType: adapted.mediaType,
                      data: buffer.toString('base64'),
                    }
                  : item;
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
}
