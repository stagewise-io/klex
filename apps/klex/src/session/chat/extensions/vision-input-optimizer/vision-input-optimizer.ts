import { createHash } from 'node:crypto';

import type { FilePart, ImagePart, ModelMessage, TextPart } from 'ai';
import sharp from 'sharp';

import type { ModelInputCapabilities } from '@/config';

import type {
  ContextProcessingResult,
  Extension,
  ExtensionDeps,
  ExtensionFactory,
  ResolvedModel,
} from '../extension-api';

export const VISION_INPUT_OPTIMIZER_IDENTIFIER =
  'io.stagewise/vision-input-optimizer';

const DEFAULT_MAX_WIDTH = 2048;
const DEFAULT_MAX_HEIGHT = 2048;
const DEFAULT_MAX_DATA_SIZE = 4_194_304; // 4 MB
const FORMAT_PREFERENCE = ['webp', 'png', 'jpeg'] as const;
const WEBP_QUALITY = 82;
const JPEG_QUALITY = 85;
const MIN_QUALITY = 42;
const QUALITY_STEP = 10;
const MIN_DIMENSION = 64;

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

/** Module-level cache shared across all extension instances. */
const cache = new Map<string, FilePart | TextPart>();

/** Clears the module-level cache. Intended for testing only. */
export function clearVisionInputOptimizerCache(): void {
  cache.clear();
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
    supportedMediaTypes: image?.mediaTypes ?? [],
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

class VisionInputOptimizerExt implements Extension {
  constructor(private readonly deps: ExtensionDeps) {}

  async contextTransformer(
    history: ModelMessage[],
    model: ResolvedModel,
  ): Promise<ContextProcessingResult> {
    const settings = resolveEffectiveVision(model.inputCapabilities);

    return Promise.all(
      history.map(async (message) => {
        if (message.role !== 'user') return message;
        if (!Array.isArray(message.content)) return message;

        const content = await Promise.all(
          message.content.map(async (part) => {
            if (part.type === 'image') {
              return this.processImagePart(part, model.modelId, settings);
            }
            if (part.type === 'file' && part.mediaType.startsWith('image')) {
              return this.processImagePart(part, model.modelId, settings);
            }
            return part;
          }),
        );
        return { ...message, content };
      }),
    );
  }

  introspect(): Record<string, unknown> {
    return {
      cacheSize: cache.size,
    };
  }

  private async processImagePart(
    part: FilePart | ImagePart,
    modelId: string,
    settings: EffectiveVision,
  ): Promise<ProcessedPart> {
    const buffer = extractImageBuffer(part);
    if (buffer === null) return part; // URL/reference — pass through uncached

    const cacheKey = `${createHash('sha1').update(buffer).digest('hex').slice(0, 16)}:${modelId}`;
    const cached = cache.get(cacheKey);
    if (cached !== undefined) return cached;

    // supports === false: replace with text notification
    if (!settings.supports) {
      const textPart: TextPart = {
        type: 'text',
        text: "Can't see this image. Vision isn't supported.",
      };
      cache.set(cacheKey, textPart);
      return textPart;
    }

    try {
      const meta = await sharp(buffer).metadata();
      const width = meta.width;
      const height = meta.height;

      if (!width || !height) {
        const filePart = buildFilePart(buffer, originalMediaType(part), part);
        cache.set(cacheKey, filePart);
        return filePart;
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
        const filePart = buildFilePart(buffer, originalMediaType(part), part);
        cache.set(cacheKey, filePart);
        return filePart;
      }

      const { buffer: output, format } = await transformImage(
        buffer,
        width,
        height,
        settings,
        meta.format,
      );
      const filePart = buildFilePart(output, `image/${format}`, part);
      cache.set(cacheKey, filePart);
      return filePart;
    } catch (error) {
      // Graceful degradation: log and replace with text notification
      this.deps.logger.error({ error }, 'Failed to process image');
      const textPart: TextPart = {
        type: 'text',
        text: "Can't see this image. Vision isn't supported.",
      };
      cache.set(cacheKey, textPart);
      return textPart;
    }
  }
}

export const createVisionInputOptimizerExt: ExtensionFactory = {
  identifier: VISION_INPUT_OPTIMIZER_IDENTIFIER,
  displayName: 'Vision Input Optimizer',
  create: (deps) => new VisionInputOptimizerExt(deps),
};
