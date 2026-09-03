import type { FilePart, ImagePart, TextPart } from 'ai';

import type { ModelInputCapabilities } from '@/config';
import {
  BoundedCache,
  dataContentToBuffer,
  estimatePartSize,
  extractBufferFromUrl,
} from '@/shared-utilities';

// Lazy-load sharp — it's a native addon. In SEA builds, sharp's JS is
// bundled into the blob and the native @img/sharp-* packages are copied to
// dist/node_modules/@img/ during packaging (see package-exe.ts).
// The build fails if native packages are missing, so this should always
// succeed. The lazy loading remains as a safety net for dev/non-SEA runs.
type SharpFn = typeof import('sharp')['default'];
let sharpModule: SharpFn | null = null;
let sharpChecked = false;

function getSharp(): SharpFn | null {
  if (sharpChecked) return sharpModule;
  sharpChecked = true;
  try {
    // Use require() for CJS compatibility in SEA builds.
    // In SEA builds `sharp` resolves to the ESM shim in build.ts, so esbuild
    // compiles this require() into a namespace object ({ default, path }) rather
    // than the callable sharp function. Unwrap `.default` or every sharp(...)
    // call throws "is not a function" while isSharpAvailable() still reports
    // true. Caught by `klex --verify-native`.
    const loaded = require('sharp') as SharpFn | { default: SharpFn };
    sharpModule =
      typeof loaded === 'function' ? loaded : (loaded.default ?? null);
  } catch {
    sharpModule = null;
  }
  return sharpModule;
}

/** Returns true if sharp is available for image processing. */
export function isSharpAvailable(): boolean {
  return getSharp() !== null;
}

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

type ImageFormat = 'webp' | 'png' | 'jpeg' | 'tiff' | 'gif' | 'avif';
export type ProcessedPart = FilePart | TextPart | ImagePart;

export interface EffectiveVision {
  supports: boolean;
  maxWidth: number;
  maxHeight: number;
  maxTotalPixels: number | undefined;
  maxDataSize: number;
  supportedMediaTypes: readonly string[];
}

// Re-export BoundedCache for consumers that import from this module
export { BoundedCache } from '@/shared-utilities';

/** Module-level cache for processed image parts (supports === true path). */
export const cache = new BoundedCache<string, FilePart | TextPart>(
  MAX_CACHE_BYTES,
  estimatePartSize,
);

/** Module-level cache for general vision descriptions (no lookFor), keyed by image hash. */
export const descriptionCache = new BoundedCache<string, string>(
  MAX_CACHE_BYTES,
  (s) => s.length,
);

/** In-flight description promises to deduplicate concurrent requests for the same image. */
export const inflightDescriptions = new Map<string, Promise<string | null>>();

/** Clears the module-level caches. Intended for testing only. */
export function clearImageInputOptimizerCache(): void {
  cache.clear();
  descriptionCache.clear();
  inflightDescriptions.clear();
}

export function resolveEffectiveVision(
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

/** Returns a Buffer if the part carries inline image data, or null if it's a remote URL/reference (can't process). */
export function extractImageBuffer(part: FilePart | ImagePart): Buffer | null {
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

const KNOWN_FORMATS: ReadonlySet<string> = new Set([
  'webp',
  'png',
  'jpeg',
  'tiff',
  'gif',
  'avif',
]);

/** Converts a mediaType string (e.g. 'image/png') to an ImageFormat, or null if not a known encodable format. */
function mediaTypeToFormat(mt: string): ImageFormat | null {
  const fmt = mt.replace(/^image\//, '');
  if (KNOWN_FORMATS.has(fmt)) return fmt as ImageFormat;
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

  // Prefer webp/png/jpeg for best compression
  for (const fmt of FORMAT_PREFERENCE) {
    if (supportedFormats.has(fmt)) return fmt;
  }

  // No preferred format is supported. Try any other encodable format
  // the model declares — better than sending an undeclared format.
  for (const fmt of supportedFormats) {
    return fmt;
  }

  // No supported format is encodable. Keep the current format if
  // we can encode it — avoids sending an undeclared format (e.g.
  // webp) to a model that only supports non-standard formats.
  if (currentFormat) {
    const fmt = mediaTypeToFormat(`image/${currentFormat}`);
    if (fmt) return fmt;
  }

  // Current format is not encodable either — best-effort webp
  return 'webp';
}

async function transformImage(
  buffer: Buffer,
  imgWidth: number,
  imgHeight: number,
  settings: EffectiveVision,
  originalFormat: string | undefined,
): Promise<{ buffer: Buffer; format: ImageFormat }> {
  const sharp = getSharp();
  if (sharp === null) {
    throw new Error('sharp is not available — image processing disabled');
  }
  const targetFormat = selectTargetFormat(
    originalFormat,
    settings.supportedMediaTypes,
  );
  const baseQuality =
    targetFormat === 'webp'
      ? WEBP_QUALITY
      : targetFormat === 'jpeg'
        ? JPEG_QUALITY
        : 85; // Default for tiff, gif, avif, etc.

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

/**
 * Core image optimization pipeline: metadata extraction, resize,
 * format conversion, and data-size reduction. Does NOT handle
 * caching or error recovery — the caller is responsible for both.
 *
 * @throws if sharp cannot parse the buffer
 * @returns Optimized FilePart (may be unchanged if no transformation needed)
 */
export async function runOptimization(
  buffer: Buffer,
  part: FilePart | ImagePart,
  settings: EffectiveVision,
): Promise<FilePart> {
  const sharp = getSharp();
  if (sharp === null) {
    throw new Error('sharp is not available — image processing disabled');
  }
  const meta = await sharp(buffer).metadata();
  const width = meta.width;
  const height = meta.height;

  if (!width || !height) {
    return buildFilePart(buffer, originalMediaType(part), part);
  }

  const needsResize = width > settings.maxWidth || height > settings.maxHeight;
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
