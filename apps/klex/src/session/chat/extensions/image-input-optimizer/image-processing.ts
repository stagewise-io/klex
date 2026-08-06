import type { FilePart, ImagePart, TextPart } from 'ai';
import sharp from 'sharp';

import type { ModelInputCapabilities } from '@/config';

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

type ImageFormat = 'webp' | 'png' | 'jpeg';
export type ProcessedPart = FilePart | TextPart | ImagePart;

export interface EffectiveVision {
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
export const cache = new BoundedCache<string, FilePart | TextPart>(
  MAX_CACHE_BYTES,
  estimatePartSize,
);

/** Module-level cache for general vision descriptions (no lookFor), keyed by image hash. */
export const descriptionCache = new BoundedCache<string, string>(
  MAX_CACHE_BYTES,
  (s) => s.length,
);

/** Clears the module-level caches. Intended for testing only. */
export function clearImageInputOptimizerCache(): void {
  cache.clear();
  descriptionCache.clear();
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
