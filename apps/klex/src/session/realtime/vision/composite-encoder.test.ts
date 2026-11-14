import { describe, expect, it } from 'vitest';

import type { RawVideoFrame } from '@/media-transport';
import { loadSharp } from '@/shared-utilities';

import {
  createSharpVideoCompositeEncoder,
  tileOverlaySvg,
} from './composite-encoder';
import { compositeLayout } from './composite-layout';

function frame(
  width: number,
  height: number,
  rotation: RawVideoFrame['rotation'] = 0,
  shade = 128,
): RawVideoFrame {
  return {
    encoding: 'rgba',
    width,
    height,
    rotation,
    sequence: 1,
    timestampUs: 0,
    data: new Uint8Array(width * height * 4).fill(shade),
  };
}

const JPEG = [0xff, 0xd8, 0xff];

describe('createSharpVideoCompositeEncoder', () => {
  const encode = createSharpVideoCompositeEncoder();
  const sharp = loadSharp();

  it('is available wherever sharp loads', () => {
    expect(Boolean(encode)).toBe(Boolean(sharp));
  });

  it.runIf(encode)('encodes one tile at its fitted size', async () => {
    if (!encode) return;
    const layout = compositeLayout(1, { width: 180, height: 320 });
    if (!layout) throw new Error('missing layout');
    const still = await encode(
      {
        width: layout.width,
        height: layout.height,
        tiles: [
          {
            rect: layout.tiles[0] as never,
            frame: frame(320, 180, 90),
            label: 'Dana · camera',
          },
        ],
      },
      { quality: 75 },
    );
    expect([still.width, still.height]).toEqual([180, 320]);
    expect([...still.data.subarray(0, 3)]).toEqual(JPEG);
  });

  it.runIf(encode && sharp)(
    'draws frames into their tiles and placeholders for tiles without one',
    async () => {
      if (!encode || !sharp) return;
      const layout = compositeLayout(2);
      if (!layout) throw new Error('missing layout');
      const [left, right] = layout.tiles;
      const still = await encode(
        {
          width: layout.width,
          height: layout.height,
          tiles: [
            {
              rect: left as never,
              frame: frame(640, 360, 0, 250),
              label: 'Dana · screen',
            },
            { rect: right as never, label: 'Lee · camera' },
          ],
        },
        { quality: 90 },
      );
      expect([still.width, still.height]).toEqual([1024, 288]);
      const { data, info } = await sharp(still.data)
        .raw()
        .toBuffer({ resolveWithObject: true });
      const pixel = (x: number, y: number) =>
        data[(y * info.width + x) * info.channels] ?? 0;
      // Above the labels: the bright frame on the left, the grey placeholder
      // on the right.
      expect(pixel(256, 100)).toBeGreaterThan(220);
      expect(pixel(768, 100)).toBeGreaterThan(25);
      expect(pixel(768, 100)).toBeLessThan(60);
    },
  );
});

describe('tileOverlaySvg', () => {
  const rect = {
    position: 'left',
    x: 0,
    y: 0,
    width: 512,
    height: 288,
  } as const;

  it('escapes and truncates the label', () => {
    const svg = tileOverlaySvg(rect, `<Dana & "co"> ${'x'.repeat(80)}`, false);
    expect(svg).toContain('&lt;Dana &amp; &quot;co&quot;&gt;');
    expect(svg).toContain('…</text>');
    expect(svg).not.toContain('<Dana');
  });

  it('fills placeholders and leaves frames uncovered', () => {
    expect(tileOverlaySvg(rect, 'Lee · camera', true)).toContain(
      '<rect width="512" height="288"',
    );
    expect(tileOverlaySvg(rect, 'Lee · camera', false)).not.toContain(
      '<rect width="512" height="288"',
    );
  });
});
