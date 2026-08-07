import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { PassThrough, Readable } from 'node:stream';

import type { FilePart, TextPart } from 'ai';
import ffmpegStaticPath from 'ffmpeg-static';
import { path as ffprobeStaticPath } from 'ffprobe-static';
import ffmpeg from 'fluent-ffmpeg';

import type { ModelInputCapabilities } from '@/config';
import {
  BoundedCache,
  dataContentToBuffer,
  estimatePartSize,
  extractBufferFromUrl,
} from '@/shared-utilities';

// Configure fluent-ffmpeg to use the bundled static binaries.
// In SEA builds, the ffmpeg-static and ffprobe-static packages are
// externalized and their binaries are copied to dist/node_modules/ during
// packaging (see package-exe.ts → copyNativeAssets). The build fails if
// any binary is missing — there is no PATH fallback.
if (ffmpegStaticPath === null || !existsSync(ffmpegStaticPath)) {
  throw new Error(
    `ffmpeg-static binary not found at ${ffmpegStaticPath}. ` +
      'The packaging step should have copied it to dist/node_modules/ffmpeg-static/.',
  );
}
if (!existsSync(ffprobeStaticPath)) {
  throw new Error(
    `ffprobe-static binary not found at ${ffprobeStaticPath}. ` +
      'The packaging step should have copied it to dist/node_modules/ffprobe-static/.',
  );
}

ffmpeg.setFfmpegPath(ffmpegStaticPath);
ffmpeg.setFfprobePath(ffprobeStaticPath);

const DEFAULT_MAX_DATA_SIZE = 25_165_824; // 24 MB
const DEFAULT_MAX_LENGTH_SECONDS = 1800; // 30 minutes
const FORMAT_PREFERENCE = ['mp3', 'wav', 'ogg', 'flac', 'aac'] as const;
const FFMPEG_TIMEOUT_MS = 30_000;
const MAX_CACHE_BYTES = 20 * 1024 * 1024; // 20 MB

type AudioFormat = 'mp3' | 'wav' | 'ogg' | 'flac' | 'aac';
export type ProcessedPart = FilePart | TextPart;

export interface EffectiveAudio {
  supports: boolean;
  maxDataSize: number;
  maxLengthSeconds: number;
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

let ffmpegAvailable: boolean | null = null;

/** Checks whether ffprobe (bundled static binary) is available. Result is cached. */
export function isFfmpegAvailable(): boolean {
  if (ffmpegAvailable !== null) return ffmpegAvailable;
  try {
    execFileSync(ffprobeStaticPath, ['-version'], {
      stdio: 'ignore',
      timeout: 5000,
    });
    ffmpegAvailable = true;
  } catch {
    ffmpegAvailable = false;
  }
  return ffmpegAvailable;
}

export function resolveEffectiveAudio(
  caps: ModelInputCapabilities | undefined,
): EffectiveAudio {
  const audio = caps?.audio;
  return {
    supports: audio !== undefined,
    maxDataSize: audio?.maxBytes ?? DEFAULT_MAX_DATA_SIZE,
    maxLengthSeconds: audio?.maxLengthSeconds ?? DEFAULT_MAX_LENGTH_SECONDS,
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
): AudioFormat | null {
  const supportedMediaSet = new Set(supportedMediaTypes);

  // Only select formats whose emitted canonical MIME is actually
  // declared by the model — avoids relabeling audio to an undeclared
  // type (e.g. audio/opus → audio/ogg when only audio/opus is declared).
  for (const fmt of FORMAT_PREFERENCE) {
    if (supportedMediaSet.has(formatToMediaType(fmt))) return fmt;
  }

  // Check other declared MIME types — only use the format if its
  // canonical MIME is also declared (prevents alias mismatches).
  for (const mt of supportedMediaTypes) {
    const fmt = mediaTypeToFormat(mt);
    if (fmt && supportedMediaSet.has(formatToMediaType(fmt))) return fmt;
  }

  // No format's canonical MIME is declared — return null so the caller
  // can preserve the original or fail rather than relabeling.
  return null;
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

/** Probes an audio buffer to verify it is valid audio. Returns duration in seconds. */
function probeAudio(inputBuffer: Buffer): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    ffmpeg(Readable.from(inputBuffer)).ffprobe(
      (err: Error | null, data: ffmpeg.FfprobeData) =>
        settle(() => {
          if (err) return reject(err);
          // Duration from format-level, fall back to stream-level
          const duration =
            data?.format?.duration ?? data?.streams?.[0]?.duration;
          resolve(typeof duration === 'number' ? duration : 0);
        }),
    );
  });
}

/** Runs ffmpeg to convert/re-encode an audio buffer. Rejects on any ffmpeg error. */
function convertAudio(
  inputBuffer: Buffer,
  targetFormat: AudioFormat,
  options: QualitySetting,
  maxOutputBytes: number,
  maxDurationSeconds?: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    const passthrough = new PassThrough();
    let command: ReturnType<typeof ffmpeg> | undefined;

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      fn();
    };

    passthrough.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > maxOutputBytes) {
        settle(() => {
          command?.kill('SIGKILL');
          reject(
            new Error(
              `Audio conversion output exceeded ${maxOutputBytes} bytes`,
            ),
          );
        });
        return;
      }
      chunks.push(chunk);
    });
    passthrough.on('end', () => settle(() => resolve(Buffer.concat(chunks))));
    passthrough.on('error', (err: Error) => settle(() => reject(err)));

    command = ffmpeg(Readable.from(inputBuffer))
      .toFormat(formatToFfmpegName(targetFormat))
      .on('error', (err: Error) => settle(() => reject(err)));

    if (maxDurationSeconds !== undefined) {
      command.duration(maxDurationSeconds);
    }
    if (options.audioBitrate) command.audioBitrate(options.audioBitrate);
    if (options.audioFrequency) command.audioFrequency(options.audioFrequency);
    if (options.audioChannels) command.audioChannels(options.audioChannels);

    timeout = setTimeout(() => {
      settle(() => {
        command?.kill('SIGKILL');
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
  originalMediaType: string,
  durationSeconds: number,
): Promise<{ buffer: Buffer; mediaType: string }> {
  const targetFormat = selectTargetFormat(
    originalFormat,
    settings.supportedMediaTypes,
  );
  const maxOutputBytes = Math.max(settings.maxDataSize * 4, 50 * 1024 * 1024);
  // Truncate audio that exceeds the max length. The conversion will
  // stop at this duration, discarding the remainder.
  // TODO: Instead of truncating, chunk long audio into segments and
  // make multiple calls to the model (or the listen fallback model)
  // to process each chunk, then combine the results.
  const maxDuration =
    durationSeconds > settings.maxLengthSeconds
      ? settings.maxLengthSeconds
      : undefined;

  // No format with a declared canonical MIME — try re-encoding in the
  // current format to preserve the original (declared) MIME type.
  if (targetFormat === null) {
    if (
      originalFormat !== null &&
      settings.supportedMediaTypes.includes(originalMediaType)
    ) {
      const steps = qualitySteps(originalFormat);
      for (const step of steps) {
        const output = await convertAudio(
          buffer,
          originalFormat,
          step,
          maxOutputBytes,
          maxDuration,
        );
        if (output.length <= settings.maxDataSize) {
          return { buffer: output, mediaType: originalMediaType };
        }
      }
    }
    throw new Error(
      'No supported audio format with a declared MIME type available for conversion',
    );
  }

  const steps = qualitySteps(targetFormat);
  for (const step of steps) {
    const output = await convertAudio(
      buffer,
      targetFormat,
      step,
      maxOutputBytes,
      maxDuration,
    );
    if (output.length <= settings.maxDataSize) {
      return { buffer: output, mediaType: formatToMediaType(targetFormat) };
    }
  }

  // All quality steps exhausted — output still exceeds maxDataSize.
  // Treat as a processing failure so the caller degrades gracefully.
  throw new Error(
    `Audio could not be reduced below maxDataSize (${settings.maxDataSize} bytes)`,
  );
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
  // Validate the audio is parseable and get its duration.
  const durationSeconds = await probeAudio(buffer);

  const originalFormat = mediaTypeToFormat(part.mediaType);
  const needsFormatChange = !settings.supportedMediaTypes.includes(
    part.mediaType,
  );
  const needsSizeReduction = buffer.length > settings.maxDataSize;
  const needsLengthTruncation = durationSeconds > settings.maxLengthSeconds;

  if (!needsFormatChange && !needsSizeReduction && !needsLengthTruncation) {
    return buildFilePart(buffer, part.mediaType, part);
  }

  const { buffer: output, mediaType } = await transformAudio(
    buffer,
    settings,
    originalFormat,
    part.mediaType,
    durationSeconds,
  );
  return buildFilePart(output, mediaType, part);
}
