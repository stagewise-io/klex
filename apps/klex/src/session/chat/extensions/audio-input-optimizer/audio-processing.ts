import { PassThrough, Readable } from 'node:stream';

import type { FilePart, TextPart } from 'ai';
import ffmpeg from 'fluent-ffmpeg';

import type { ModelInputCapabilities } from '@/config';
import {
  BoundedCache,
  dataContentToBuffer,
  estimatePartSize,
  extractBufferFromUrl,
} from '@/shared-utilities';

const DEFAULT_MAX_DATA_SIZE = 25_165_824; // 24 MB
const FORMAT_PREFERENCE = ['mp3', 'wav', 'ogg', 'flac', 'aac'] as const;
const FFMPEG_TIMEOUT_MS = 30_000;
const MAX_CACHE_BYTES = 20 * 1024 * 1024; // 20 MB

type AudioFormat = 'mp3' | 'wav' | 'ogg' | 'flac' | 'aac';
export type ProcessedPart = FilePart | TextPart;

export interface EffectiveAudio {
  supports: boolean;
  maxDataSize: number;
  supportedMediaTypes: readonly string[];
}

// Re-export BoundedCache for consumers that import from this module
export { BoundedCache } from '@/shared-utilities';

/** Module-level cache for processed audio parts (supports === true path). */
export const cache = new BoundedCache<string, FilePart | TextPart>(
  MAX_CACHE_BYTES,
  estimatePartSize,
);

/** Module-level cache for general audio descriptions (no lookFor), keyed by audio hash. */
export const descriptionCache = new BoundedCache<string, string>(
  MAX_CACHE_BYTES,
  (s) => s.length,
);

/** In-flight description promises to deduplicate concurrent requests for the same audio. */
export const inflightDescriptions = new Map<string, Promise<string | null>>();

/** Clears the module-level caches. Intended for testing only. */
export function clearAudioInputOptimizerCache(): void {
  cache.clear();
  descriptionCache.clear();
  inflightDescriptions.clear();
}

export function resolveEffectiveAudio(
  caps: ModelInputCapabilities | undefined,
): EffectiveAudio {
  const audio = caps?.audio;
  return {
    supports: audio !== undefined,
    maxDataSize: audio?.maxBytes ?? DEFAULT_MAX_DATA_SIZE,
    supportedMediaTypes: audio?.mediaTypes ?? [],
  };
}

/** Returns a Buffer if the part carries inline audio data, or null if it's a remote URL/reference (can't process). */
export function extractAudioBuffer(part: FilePart): Buffer | null {
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
  part: FilePart,
): FilePart {
  return {
    type: 'file',
    data: { type: 'data', data: buffer.toString('base64') },
    mediaType,
    ...(part.filename !== undefined && { filename: part.filename }),
    ...(part.providerOptions !== undefined && {
      providerOptions: part.providerOptions,
    }),
  };
}

export function mediaTypeToFormat(mt: string): AudioFormat | null {
  const sub = mt.replace(/^audio\//, '').replace(/^x-/, '');
  switch (sub) {
    case 'mpeg':
    case 'mp3':
      return 'mp3';
    case 'wav':
      return 'wav';
    case 'ogg':
    case 'opus':
      return 'ogg';
    case 'flac':
      return 'flac';
    case 'aac':
    case 'mp4':
    case 'm4a':
      return 'aac';
    default:
      return null;
  }
}

export function formatToMediaType(fmt: AudioFormat): string {
  switch (fmt) {
    case 'mp3':
      return 'audio/mpeg';
    case 'wav':
      return 'audio/wav';
    case 'ogg':
      return 'audio/ogg';
    case 'flac':
      return 'audio/flac';
    case 'aac':
      return 'audio/aac';
  }
}

function formatToFfmpegName(fmt: AudioFormat): string {
  switch (fmt) {
    case 'mp3':
      return 'mp3';
    case 'wav':
      return 'wav';
    case 'ogg':
      return 'ogg';
    case 'flac':
      return 'flac';
    case 'aac':
      return 'adts';
  }
}

function selectTargetFormat(
  currentFormat: AudioFormat | null,
  supportedMediaTypes: readonly string[],
): AudioFormat {
  const supportedFormats = new Set<AudioFormat>();
  for (const mt of supportedMediaTypes) {
    const fmt = mediaTypeToFormat(mt);
    if (fmt) supportedFormats.add(fmt);
  }

  for (const fmt of FORMAT_PREFERENCE) {
    if (supportedFormats.has(fmt)) return fmt;
  }

  if (currentFormat !== null) {
    return currentFormat;
  }
  return 'mp3';
}

interface QualitySetting {
  audioBitrate?: string;
  audioFrequency?: number;
  audioChannels?: number;
}

/** Ordered quality steps to try when re-encoding. First entry is highest quality. */
function qualitySteps(targetFormat: AudioFormat): readonly QualitySetting[] {
  if (targetFormat === 'wav' || targetFormat === 'flac') {
    // Lossless formats — reduce sample rate and channels
    return [
      {},
      { audioFrequency: 22050 },
      { audioFrequency: 22050, audioChannels: 1 },
      { audioFrequency: 16000, audioChannels: 1 },
      { audioFrequency: 8000, audioChannels: 1 },
    ];
  }
  // Compressed formats — reduce bitrate
  return [
    { audioBitrate: '128k' },
    { audioBitrate: '96k' },
    { audioBitrate: '64k' },
    { audioBitrate: '48k' },
    { audioBitrate: '32k' },
  ];
}

/** Probes an audio buffer to verify it is valid audio. Rejects on any ffprobe error. */
function probeAudio(inputBuffer: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    ffmpeg(Readable.from(inputBuffer)).ffprobe((err: Error | null) =>
      settle(() => (err ? reject(err) : resolve())),
    );
  });
}

/** Runs ffmpeg to convert/re-encode an audio buffer. Rejects on any ffmpeg error. */
function convertAudio(
  inputBuffer: Buffer,
  targetFormat: AudioFormat,
  options: QualitySetting,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const chunks: Buffer[] = [];
    const passthrough = new PassThrough();

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      fn();
    };

    passthrough.on('data', (chunk: Buffer) => chunks.push(chunk));
    passthrough.on('end', () => settle(() => resolve(Buffer.concat(chunks))));
    passthrough.on('error', (err: Error) => settle(() => reject(err)));

    const command = ffmpeg(Readable.from(inputBuffer))
      .toFormat(formatToFfmpegName(targetFormat))
      .on('error', (err: Error) => settle(() => reject(err)));

    if (options.audioBitrate) command.audioBitrate(options.audioBitrate);
    if (options.audioFrequency) command.audioFrequency(options.audioFrequency);
    if (options.audioChannels) command.audioChannels(options.audioChannels);

    timeout = setTimeout(() => {
      settle(() => {
        command.kill('SIGKILL');
        reject(new Error('Audio conversion timed out'));
      });
    }, FFMPEG_TIMEOUT_MS);

    command.pipe(passthrough);
  });
}

async function transformAudio(
  buffer: Buffer,
  settings: EffectiveAudio,
  originalFormat: AudioFormat | null,
): Promise<{ buffer: Buffer; format: AudioFormat }> {
  const targetFormat = selectTargetFormat(
    originalFormat,
    settings.supportedMediaTypes,
  );
  const steps = qualitySteps(targetFormat);
  let lastOutput: Buffer | null = null;

  for (const step of steps) {
    const output = await convertAudio(buffer, targetFormat, step);
    lastOutput = output;
    if (output.length <= settings.maxDataSize) {
      return { buffer: output, format: targetFormat };
    }
  }

  // All quality steps exhausted — return the smallest output we produced
  // biome-ignore lint/style/noNonNullAssertion: loop guarantees at least one iteration produces output
  return { buffer: lastOutput!, format: targetFormat };
}

/**
 * Core audio optimization pipeline: validation, format conversion,
 * and data-size reduction. Does NOT handle caching or error recovery —
 * the caller is responsible for both.
 *
 * @throws if ffmpeg cannot parse the buffer
 * @returns Optimized FilePart (may be unchanged if no transformation needed)
 */
export async function runOptimization(
  buffer: Buffer,
  part: FilePart,
  settings: EffectiveAudio,
): Promise<FilePart> {
  // Validate the audio is parseable — analogous to sharp(buffer).metadata()
  await probeAudio(buffer);

  const originalFormat = mediaTypeToFormat(part.mediaType);
  const needsFormatChange = !settings.supportedMediaTypes.includes(
    part.mediaType,
  );
  const needsSizeReduction = buffer.length > settings.maxDataSize;

  if (!needsFormatChange && !needsSizeReduction) {
    return buildFilePart(buffer, part.mediaType, part);
  }

  const { buffer: output, format } = await transformAudio(
    buffer,
    settings,
    originalFormat,
  );
  return buildFilePart(output, formatToMediaType(format), part);
}
