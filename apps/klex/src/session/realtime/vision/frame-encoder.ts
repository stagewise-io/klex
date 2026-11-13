import type { RawVideoFrame } from '@/media-transport';
import { loadSharp } from '@/shared-utilities';

export interface EncodedVideoStill {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/** Rotates upright, fits within `maxLongEdge`, and encodes one JPEG. */
export type VideoFrameEncoder = (
  frame: RawVideoFrame,
  options: { maxLongEdge: number; quality: number },
) => Promise<EncodedVideoStill>;

/** Returns undefined when sharp's native addon is unavailable. */
export function createSharpVideoFrameEncoder(): VideoFrameEncoder | undefined {
  const sharp = loadSharp();
  if (!sharp) return undefined;
  return async (frame, options) => {
    let pipeline = sharp(frame.data, {
      raw: { width: frame.width, height: frame.height, channels: 4 },
    });
    if (frame.rotation !== 0) pipeline = pipeline.rotate(frame.rotation);
    const { data, info } = await pipeline
      .resize({
        width: options.maxLongEdge,
        height: options.maxLongEdge,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .removeAlpha()
      .jpeg({ quality: options.quality })
      .toBuffer({ resolveWithObject: true });
    return {
      data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      width: info.width,
      height: info.height,
    };
  };
}
