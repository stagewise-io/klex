import { createHash } from 'node:crypto';

import {
  type FilePart,
  type ImagePart,
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
  cache,
  descriptionCache,
  type EffectiveVision,
  extractImageBuffer,
  type ProcessedPart,
  resolveEffectiveVision,
  runOptimization,
} from './image-processing';
import {
  describeImage,
  resolveVisionModels,
  stripViewImageFromHistory,
  UNSUPPORTED_IMAGE_TEXT,
  VIEW_IMAGE_TOOL_NAME,
} from './vision-helper';
import visionSystemPrompt from './vision-system-prompt.md';
import visionToolPrompt from './vision-tool-system-prompt.md';

export {
  BoundedCache,
  clearImageInputOptimizerCache,
} from './image-processing';

export const IMAGE_INPUT_OPTIMIZER_IDENTIFIER =
  'io.stagewise/image-input-optimizer';

class ImageInputOptimizerExt implements Extension {
  /**
   * Maps image IDs to their original parts, rebuilt on each context
   * transformation so the viewImage tool can access images by ID.
   */
  private readonly imageRegistry = new Map<string, FilePart | ImagePart>();

  constructor(private readonly deps: ExtensionDeps) {
    // sharp is guaranteed to be available — the build fails if native
    // packages are missing (see package-exe.ts → copyNativeAssets).
    // isSharpAvailable() remains as a defensive check for dev/non-SEA runs.
  }

  getTools(model: ResolvedModel): ToolSet {
    // Only expose the viewImage tool when the active model cannot see
    // images. Vision-capable models don't need this tool.
    const settings = resolveEffectiveVision(model.inputCapabilities);
    if (settings.supports) return {};

    const visionModelIds = resolveVisionModels(this.deps.config);
    if (visionModelIds.length === 0) return {};

    return {
      [VIEW_IMAGE_TOOL_NAME]: tool({
        description:
          'Get more information about an image that referenced this tool. Only use this tool when an image placeholder in the conversation instructs you to do so. Pass the image ID from the placeholder text and specify "lookFor" to focus on specific aspects of the image.',
        inputSchema: z.object({
          id: z
            .string()
            .describe('The image ID from the placeholder text (e.g. "0-1")'),
          lookFor: z
            .string()
            .describe(
              'What to specifically look for in the image (e.g. "text content", "colors", "layout")',
            ),
        }),
        execute: async ({ id, lookFor }) => {
          const imagePart = this.imageRegistry.get(id);
          if (imagePart === undefined) {
            return `Image with ID "${id}" not found. It may have been from a previous conversation turn.`;
          }

          const toolBuffer = extractImageBuffer(imagePart);
          const toolImageHash = toolBuffer
            ? createHash('sha1').update(toolBuffer).digest('hex').slice(0, 16)
            : null;
          const toolVisionModelIds = resolveVisionModels(this.deps.config);

          const description = await describeImage(
            this.deps,
            imagePart,
            toolVisionModelIds,
            toolBuffer,
            toolImageHash,
            lookFor,
            visionToolPrompt,
          );
          if (description !== null) return description;

          return 'Unable to analyze this image. The vision model could not process it.';
        },
      }),
    };
  }

  async contextTransformer(
    history: ModelMessage[],
    model: ResolvedModel,
  ): Promise<ContextProcessingResult> {
    const settings = resolveEffectiveVision(model.inputCapabilities);

    // Clear the image registry at the start of each context transformation
    // so IDs from the previous step don't linger.
    this.imageRegistry.clear();

    // Pre-compute vision model availability for the non-vision path.
    const visionModelIds = resolveVisionModels(this.deps.config);
    const hasVisionModels = !settings.supports && visionModelIds.length > 0;

    // Determine whether the viewImage tool will be offered to this model.
    // If not, any viewImage tool calls/results in history must be stripped
    // and inlined as text so the model doesn't see calls to an unknown tool
    // (e.g. after a model fallback to a vision-capable model).
    const shouldStripViewImageTool = !hasVisionModels;

    const transformed = await Promise.all(
      history.map(async (message, messageIndex) => {
        if (!Array.isArray(message.content)) return message;

        // User messages: process ImagePart and FilePart with image media types
        if (message.role === 'user') {
          const content = await Promise.all(
            message.content.map(async (part, partIndex) => {
              if (part.type === 'image') {
                return this.processImagePart(
                  part,
                  model.modelId,
                  settings,
                  `${messageIndex}-${partIndex}`,
                  hasVisionModels,
                  visionModelIds,
                );
              }
              if (part.type === 'file' && part.mediaType.startsWith('image')) {
                return this.processImagePart(
                  part,
                  model.modelId,
                  settings,
                  `${messageIndex}-${partIndex}`,
                  hasVisionModels,
                  visionModelIds,
                );
              }
              return part;
            }),
          );
          return { ...message, content };
        }

        // Assistant messages: process FilePart with image media types
        // (e.g. generated images, reasoning file parts)
        if (message.role === 'assistant') {
          const content = await Promise.all(
            message.content.map(async (part, partIndex) => {
              if (part.type === 'file' && part.mediaType.startsWith('image')) {
                return this.processImagePart(
                  part,
                  model.modelId,
                  settings,
                  `${messageIndex}-${partIndex}`,
                  hasVisionModels,
                  visionModelIds,
                ) as unknown as typeof part;
              }
              return part;
            }),
          );
          return { ...message, content };
        }

        // Tool messages: process image file items inside tool-result outputs
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
                    item.mediaType.startsWith('image')
                  ) {
                    return this.processImagePart(
                      item as FilePart,
                      model.modelId,
                      settings,
                      `${messageIndex}-${partIndex}-${valueIndex}`,
                      hasVisionModels,
                      visionModelIds,
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

    if (!shouldStripViewImageTool) return transformed;

    return stripViewImageFromHistory(transformed);
  }

  introspect(): Record<string, unknown> {
    return {
      cacheSize: cache.size,
      descriptionCacheSize: descriptionCache.size,
      registeredImages: this.imageRegistry.size,
    };
  }

  private async processImagePart(
    part: FilePart | ImagePart,
    modelId: string,
    settings: EffectiveVision,
    imageId: string,
    hasVisionModels: boolean,
    visionModelIds: readonly ModelSelectionEntry[],
  ): Promise<ProcessedPart> {
    const buffer = extractImageBuffer(part);

    // supports === false: replace with description or fallback text
    if (!settings.supports) {
      if (hasVisionModels) {
        const id = imageId;
        this.imageRegistry.set(id, part);

        if (buffer === null) {
          // URL/reference image — can't extract inline data to
          // generate a general description. Still register it so the
          // viewImage tool can attempt to analyze it on-demand.
          return {
            type: 'text',
            text: `Can't directly see image. Use tool '${VIEW_IMAGE_TOOL_NAME}' with ID ${id} to get information on image content.`,
          };
        }

        // Generate a general description of the image. This is cached
        // by image hash (no lookFor) and shared across all non-vision
        // models, so it is only generated once per unique image.
        const imageHash = createHash('sha1')
          .update(buffer)
          .digest('hex')
          .slice(0, 16);
        const description = await describeImage(
          this.deps,
          part,
          visionModelIds,
          buffer,
          imageHash,
          undefined,
          visionSystemPrompt,
        );
        if (description !== null) {
          return {
            type: 'text',
            text: `${description}\n\nFor more specific details about this image, use the '${VIEW_IMAGE_TOOL_NAME}' tool with ID ${id}.`,
          };
        }
        // Vision model call failed — still offer the tool so the model
        // can retry on-demand.
        return {
          type: 'text',
          text: `Can't directly see image. Use tool '${VIEW_IMAGE_TOOL_NAME}' with ID ${id} to get information on image content.`,
        };
      }
      return { type: 'text', text: UNSUPPORTED_IMAGE_TEXT };
    }

    // supports === true: pass through URL/reference images uncached
    if (buffer === null) return part;

    // supports === true: process image (resize, format, etc.) with caching
    const cacheKey = `${createHash('sha1').update(buffer).digest('hex').slice(0, 16)}:${modelId}`;
    const cached = cache.get(cacheKey);
    if (cached !== undefined) return cached;

    try {
      const filePart = await runOptimization(buffer, part, settings);
      cache.set(cacheKey, filePart);
      return filePart;
    } catch (error) {
      // Graceful degradation: log and replace with text notification
      this.deps.logger.error({ error }, 'Failed to process image');
      const textPart: TextPart = {
        type: 'text',
        text: UNSUPPORTED_IMAGE_TEXT,
      };
      cache.set(cacheKey, textPart);
      return textPart;
    }
  }
}

export const createImageInputOptimizerExt: ExtensionFactory = {
  identifier: IMAGE_INPUT_OPTIMIZER_IDENTIFIER,
  displayName: 'Image Input Optimizer',
  create: (deps) => new ImageInputOptimizerExt(deps),
};
