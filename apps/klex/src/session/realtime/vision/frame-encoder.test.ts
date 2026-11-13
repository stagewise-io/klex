import { describe, expect, it } from 'vitest';

import type { RawVideoFrame } from '@/media-transport';
import { loadSharp } from '@/shared-utilities';

import { createSharpVideoFrameEncoder } from './frame-encoder';

function frame(
  width: number,
  height: number,
  rotation: RawVideoFrame['rotation'] = 0,
): RawVideoFrame {
  return {
    encoding: 'rgba',
    width,
    height,
    rotation,
    sequence: 1,
    timestampUs: 0,
    data: new Uint8Array(width * height * 4).fill(128),
  };
}

describe('createSharpVideoFrameEncoder', () => {
  const encode = createSharpVideoFrameEncoder();

  it('is available wherever sharp loads', () => {
    expect(Boolean(encode)).toBe(Boolean(loadSharp()));
  });

  it.runIf(encode)('downscales to the long edge and encodes JPEG', async () => {
    if (!encode) return;
    const still = await encode(frame(2048, 1152), {
      maxLongEdge: 1024,
      quality: 75,
    });
    expect([still.width, still.height]).toEqual([1024, 576]);
    expect([...still.data.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
  });

  it.runIf(encode)('applies rotation and never upscales', async () => {
    if (!encode) return;
    const still = await encode(frame(320, 180, 90), {
      maxLongEdge: 1024,
      quality: 75,
    });
    expect([still.width, still.height]).toEqual([180, 320]);
  });
});
