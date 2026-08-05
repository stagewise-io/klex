import { createHash } from 'node:crypto';

import {
  type FilePart,
  type ImagePart,
  type ModelMessage,
  type TextPart,
  type ToolResultPart,
  type ToolSet,
  tool,
} from 'ai';
import sharp from 'sharp';
import z from 'zod';

import type { ModelInputCapabilities, ModelSelectionEntry } from '@/config';
import { modelIdFromEntry } from '@/config';

import type {
  ContextProcessingResult,
  Extension,
  ExtensionDeps,
  ExtensionFactory,
  ResolvedModel,
} from '../extension-api';
import visionSystemPrompt from './vision-system-prompt.md';
import visionToolPrompt from './vision-tool-prompt.md';

export const IMAGE_INPUT_OPTIMIZER_IDENTIFIER =
  'io.stagewise/image-input-optimizer';

const DEFAULT_MAX_WIDTH = 2048;
const DEFAULT_MAX_HEIGHT = 2048;
const DEFAULT_MAX_DATA_SIZE = 4_194_304; // 4 MB
const FORMAT_PREFERENCE = ['webp', 'png', 'jpeg'] as const;
const WEBP_QUALITY = 82;
const JPEG_QUALITY = 85;
const MIN_QUALITY = 42;
const QUALITY_STEP = 10;
const MIN_DIMENSION = 64;
const MAX_CACHE_BYTES = 20 * 1024 * 1024; // 20 MB
const DEFAULT_MEDIA_TYPES = ['image/webp', 'image/png', 'image/jpeg'] as const;

const UNSUPPORTED_IMAGE_TEXT =
  "Can't see the image, you have no vision capabilities or vision model as a helper to see the image.";

const VIEW_IMAGE_TOOL_NAME = 'viewImage';

type ImageFormat = 'webp' | 'png' | 'jpeg';
type ProcessedPart = FilePart | TextPart | ImagePart;

interface EffectiveVision {
  supports: boolean;
  maxWidth: number;
  maxHeight: number;
  maxTotalPixels: number | undefined;
  maxDataSize: number;
  supportedMediaTypes: readonly string[];
}

/**
 * Size-bounded cache. Evicts oldest entries (FIFO — Map preserves
 * insertion order) when total estimated size exceeds maxBytes.
 * Prevents unbounded memory growth across sessions.
 */
export class BoundedCache<K, V> {
  private readonly map = new Map<K, V>();
  private totalSize = 0;

  constructor(
    private readonly maxBytes: number,
    private readonly estimateSize: (value: V) => number,
  ) {}

  get(key: K): V | undefined {
    return this.map.get(key);
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.totalSize -= this.estimateSize(this.map.get(key) as V);
    }
    this.totalSize += this.estimateSize(value);
    this.map.set(key, value);

    while (this.totalSize > this.maxBytes && this.map.size > 1) {
      const firstKey = this.map.keys().next().value;
      if (firstKey === undefined) break;
      this.totalSize -= this.estimateSize(this.map.get(firstKey) as V);
      this.map.delete(firstKey);
    }
  }

  clear(): void {
    this.map.clear();
    this.totalSize = 0;
  }

  get size(): number {
    return this.map.size;
  }
}

function estimatePartSize(part: FilePart | TextPart): number {
  if (part.type === 'text') return part.text.length;
  const data = part.data;
  if (typeof data === 'string') return data.length;
  if (
    data &&
    typeof data === 'object' &&
    'type' in data &&
    data.type === 'data' &&
    'data' in data &&
    typeof data.data === 'string'
  ) {
    return data.data.length;
  }
  return 1024; // Fallback for URL/reference parts
}

/** Module-level cache for processed image parts (supports === true path). */
const cache = new BoundedCache<string, FilePart | TextPart>(
  MAX_CACHE_BYTES,
  estimatePartSize,
);

/** Module-level cache for general vision descriptions (no lookFor), keyed by image hash. */
const descriptionCache = new BoundedCache<string, string>(
  MAX_CACHE_BYTES,
  (s) => s.length,
);

/** Clears the module-level caches. Intended for testing only. */
export function clearImageInputOptimizerCache(): void {
  cache.clear();
  descriptionCache.clear();
}

function resolveEffectiveVision(
  caps: ModelInputCapabilities | undefined,
): EffectiveVision {
  const image = caps?.image;
  return {
    supports: image !== undefined,
    maxWidth: image?.maxWidth ?? DEFAULT_MAX_WIDTH,
    maxHeight: image?.maxHeight ?? DEFAULT_MAX_HEIGHT,
    maxTotalPixels: image?.maxTotalPixels,
    maxDataSize: image?.maxBytes ?? DEFAULT_MAX_DATA_SIZE,
    supportedMediaTypes:
      image?.mediaTypes && image.mediaTypes.length > 0
        ? image.mediaTypes
        : DEFAULT_MEDIA_TYPES,
  };
}

function dataContentToBuffer(data: unknown): Buffer {
  if (typeof data === 'string') return Buffer.from(data, 'base64');
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data as Uint8Array);
}

/** Parses a `data:` URL and returns the decoded buffer, or null for remote URLs. */
function extractBufferFromUrl(url: URL): Buffer | null {
  if (url.protocol !== 'data:') return null; // Remote URL — pass through
  const str = url.toString();
  const comma = str.indexOf(',');
  if (comma === -1) return null;
  const meta = str.slice(5, comma); // Remove "data:" prefix
  const payload = str.slice(comma + 1);
  if (!meta.includes('base64')) return null;
  return Buffer.from(payload, 'base64');
}

/** Returns a Buffer if the part carries inline image data, or null if it's a remote URL/reference (can't process). */
function extractImageBuffer(part: FilePart | ImagePart): Buffer | null {
  if (part.type === 'image') {
    const image = part.image;
    if (image instanceof URL) return extractBufferFromUrl(image);
    if (typeof image === 'string') return Buffer.from(image, 'base64');
    if (image instanceof Uint8Array) return Buffer.from(image);
    if (image instanceof ArrayBuffer) return Buffer.from(new Uint8Array(image));
    return null; // ProviderReference
  }

  const data = part.data;
  // Bare DataContent
  if (typeof data === 'string') return Buffer.from(data, 'base64');
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data));
  // Bare URL
  if (data instanceof URL) return extractBufferFromUrl(data);
  // Tagged FileData or ProviderReference
  if (typeof data === 'object' && data !== null) {
    const tagged = data as { type?: string; data?: unknown; url?: URL };
    if (tagged.type === 'data' && tagged.data !== undefined) {
      return dataContentToBuffer(tagged.data);
    }
    if (tagged.type === 'url' && tagged.url instanceof URL) {
      return extractBufferFromUrl(tagged.url);
    }
  }
  return null;
}

function buildFilePart(
  buffer: Buffer,
  mediaType: string,
  part: FilePart | ImagePart,
): FilePart {
  return {
    type: 'file',
    data: { type: 'data', data: buffer.toString('base64') },
    mediaType,
    ...(part.type === 'file' &&
      part.filename !== undefined && { filename: part.filename }),
    ...(part.providerOptions !== undefined && {
      providerOptions: part.providerOptions,
    }),
  };
}

/** Returns the mediaType to use when passing an image part through unchanged. */
function originalMediaType(part: FilePart | ImagePart): string {
  return part.type === 'file' ? part.mediaType : (part.mediaType ?? 'image');
}

/** Converts a mediaType string (e.g. 'image/png') to an ImageFormat, or null if not a known encodable format. */
function mediaTypeToFormat(mt: string): ImageFormat | null {
  const fmt = mt.replace(/^image\//, '');
  if (fmt === 'png' || fmt === 'webp' || fmt === 'jpeg') return fmt;
  return null;
}

function selectTargetFormat(
  currentFormat: string | undefined,
  supportedMediaTypes: readonly string[],
): ImageFormat {
  const supportedFormats = new Set<ImageFormat>();
  for (const mt of supportedMediaTypes) {
    const fmt = mediaTypeToFormat(mt);
    if (fmt) supportedFormats.add(fmt);
  }

  for (const fmt of FORMAT_PREFERENCE) {
    if (supportedFormats.has(fmt)) return fmt;
  }

  if (
    currentFormat === 'webp' ||
    currentFormat === 'png' ||
    currentFormat === 'jpeg'
  ) {
    return currentFormat;
  }
  return 'webp';
}

async function transformImage(
  buffer: Buffer,
  imgWidth: number,
  imgHeight: number,
  settings: EffectiveVision,
  originalFormat: string | undefined,
): Promise<{ buffer: Buffer; format: ImageFormat }> {
  const targetFormat = selectTargetFormat(
    originalFormat,
    settings.supportedMediaTypes,
  );
  const baseQuality = targetFormat === 'webp' ? WEBP_QUALITY : JPEG_QUALITY;

  // Compute resize target — capped by maxWidth/maxHeight and maxTotalPixels
  let targetWidth = Math.min(settings.maxWidth, imgWidth);
  let targetHeight = Math.min(settings.maxHeight, imgHeight);
  if (
    settings.maxTotalPixels !== undefined &&
    targetWidth * targetHeight > settings.maxTotalPixels
  ) {
    const scale = Math.sqrt(
      settings.maxTotalPixels / (targetWidth * targetHeight),
    );
    targetWidth = Math.floor(targetWidth * scale);
    targetHeight = Math.floor(targetHeight * scale);
  }

  let quality = baseQuality;
  let curWidth = targetWidth;
  let curHeight = targetHeight;

  for (;;) {
    const output = await sharp(buffer)
      .resize({
        width: curWidth,
        height: curHeight,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .toFormat(targetFormat, { quality })
      .toBuffer();

    if (output.length <= settings.maxDataSize) {
      return { buffer: output, format: targetFormat };
    }
    if (quality > MIN_QUALITY) {
      quality -= QUALITY_STEP;
      continue;
    }
    // At minimum quality — halve dimensions and restart quality
    curWidth = Math.max(MIN_DIMENSION, Math.floor(curWidth / 2));
    curHeight = Math.max(MIN_DIMENSION, Math.floor(curHeight / 2));
    quality = baseQuality;
    if (curWidth === MIN_DIMENSION && curHeight === MIN_DIMENSION) {
      return { buffer: output, format: targetFormat };
    }
  }
}

class ImageInputOptimizerExt implements Extension {
  /**
   * Maps image IDs to their original parts, rebuilt on each context
   * transformation so the viewImage tool can access images by ID.
   */
  private readonly imageRegistry = new Map<string, FilePart | ImagePart>();

  constructor(private readonly deps: ExtensionDeps) {}

  getTools(model: ResolvedModel): ToolSet {
    // Only expose the viewImage tool when the active model cannot see
    // images. Vision-capable models don't need this tool.
    const settings = resolveEffectiveVision(model.inputCapabilities);
    if (settings.supports) return {};

    const visionModelIds = this.resolveVisionModels();
    if (visionModelIds.length === 0) return {};

    return {
      [VIEW_IMAGE_TOOL_NAME]: tool({
        description:
          'Retrieve a more detailed description of an image you cannot directly see. Pass the image ID from the placeholder text. Optionally specify "lookFor" to focus the description on specific aspects of the image.',
        inputSchema: z.object({
          id: z
            .string()
            .describe('The image ID from the placeholder text (e.g. "0-1")'),
          lookFor: z
            .string()
            .optional()
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
          const toolVisionModelIds = this.resolveVisionModels();

          const description = await this.describeImage(
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
    const visionModelIds = this.resolveVisionModels();
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

    return this.stripViewImageFromHistory(transformed);
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
    if (buffer === null) return part; // URL/reference — pass through uncached

    // supports === false: replace with description or fallback text
    if (!settings.supports) {
      if (hasVisionModels) {
        const id = imageId;
        this.imageRegistry.set(id, part);

        // Generate a general description of the image. This is cached
        // by image hash (no lookFor) and shared across all non-vision
        // models, so it is only generated once per unique image.
        const imageHash = createHash('sha1')
          .update(buffer)
          .digest('hex')
          .slice(0, 16);
        const description = await this.describeImage(
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

    // supports === true: process image (resize, format, etc.) with caching
    const cacheKey = `${createHash('sha1').update(buffer).digest('hex').slice(0, 16)}:${modelId}`;
    const cached = cache.get(cacheKey);
    if (cached !== undefined) return cached;

    try {
      const filePart = await this.runOptimization(buffer, part, settings);
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

  /**
   * Core image optimization pipeline: metadata extraction, resize,
   * format conversion, and data-size reduction. Does NOT handle
   * caching or error recovery — the caller is responsible for both.
   *
   * @throws if sharp cannot parse the buffer
   * @returns Optimized FilePart (may be unchanged if no transformation needed)
   */
  private async runOptimization(
    buffer: Buffer,
    part: FilePart | ImagePart,
    settings: EffectiveVision,
  ): Promise<FilePart> {
    const meta = await sharp(buffer).metadata();
    const width = meta.width;
    const height = meta.height;

    if (!width || !height) {
      return buildFilePart(buffer, originalMediaType(part), part);
    }

    const needsResize =
      width > settings.maxWidth || height > settings.maxHeight;
    const needsPixelReduction =
      settings.maxTotalPixels !== undefined &&
      width * height > settings.maxTotalPixels;
    const currentMediaType = `image/${meta.format ?? 'webp'}`;
    const needsFormatChange =
      !settings.supportedMediaTypes.includes(currentMediaType);
    const needsSizeReduction = buffer.length > settings.maxDataSize;

    if (
      !needsResize &&
      !needsPixelReduction &&
      !needsFormatChange &&
      !needsSizeReduction
    ) {
      return buildFilePart(buffer, originalMediaType(part), part);
    }

    const { buffer: output, format } = await transformImage(
      buffer,
      width,
      height,
      settings,
      meta.format,
    );
    return buildFilePart(output, `image/${format}`, part);
  }

  /**
   * Optimizes an image part for the first configured vision helper
   * model's input capabilities. Uses the same optimization pipeline
   * as the main image processing path (resize, format conversion,
   * metadata stripping, data-size reduction). Falls back to the
   * original part if no vision models are configured, the model
   * can't be resolved, or optimization fails.
   */
  private async optimizeForVisionHelper(
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
      const info = this.deps.config.resolveModelInfo(firstEntry);
      settings = resolveEffectiveVision(info.inputCapabilities);
    } catch {
      return part;
    }

    if (!settings.supports) return part;

    const cacheKey = `${imageHash}:${visionModelId}`;
    const cached = cache.get(cacheKey);
    if (cached !== undefined && cached.type !== 'text') return cached;

    try {
      const filePart = await this.runOptimization(buffer, part, settings);
      cache.set(cacheKey, filePart);
      return filePart;
    } catch (error) {
      this.deps.logger.error(
        { error },
        'Failed to optimize image for vision model',
      );
      return part; // Return original — vision model may still handle it
    }
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
  private stripViewImageFromHistory(history: ModelMessage[]): ModelMessage[] {
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
            viewImageResults.set(
              part.toolCallId,
              this.extractToolResultText(part),
            );
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

  /**
   * Extracts a text string from a ToolResultPart's output field.
   */
  private extractToolResultText(part: ToolResultPart): string {
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

  /**
   * Resolves the configured image-vision helper models, filtering to only
   * those whose metadata confirms image input capability. Models that fail
   * to resolve (e.g. broken provider references) are silently excluded.
   */
  private resolveVisionModels(): readonly ModelSelectionEntry[] {
    const entries = this.deps.config.getModelSelection('imageVision');
    return entries.filter((entry) => {
      try {
        const info = this.deps.config.resolveModelInfo(entry);
        return info.inputCapabilities?.image !== undefined;
      } catch {
        return false;
      }
    });
  }

  /**
   * Calls a vision-capable model to produce a textual description of
   * the image. Falls back to chat models with image capability if all
   * vision models fail. Returns null if all attempts fail. General
   * descriptions (no lookFor) are cached by image hash so they are not
   * regenerated on every step. Targeted descriptions (with lookFor) are
   * not cached — their results live in the chat history as tool results.
   */
  private async describeImage(
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
    const optimizedPart = await this.optimizeForVisionHelper(
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

    const result = await this.deps.generateText({
      modelIds: visionModelIds,
      system: systemPrompt,
      messages,
    });

    if (result.success) {
      if (imageHash && !lookFor) descriptionCache.set(imageHash, result.text);
      return result.text;
    }

    // Fallback: try chat models with image capability
    const chatEntries = this.deps.config.getModelSelection('chat');
    const visionChatEntries = chatEntries.filter((entry) => {
      try {
        const info = this.deps.config.resolveModelInfo(entry);
        return info.inputCapabilities?.image !== undefined;
      } catch {
        return false;
      }
    });

    if (visionChatEntries.length > 0) {
      this.deps.logger.warn(
        'All vision models failed — falling back to chat models with image capability',
      );
      const fallbackResult = await this.deps.generateText({
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
}

export const createImageInputOptimizerExt: ExtensionFactory = {
  identifier: IMAGE_INPUT_OPTIMIZER_IDENTIFIER,
  displayName: 'Image Input Optimizer',
  create: (deps) => new ImageInputOptimizerExt(deps),
};
