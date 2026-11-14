import type { RawVideoFrame } from '@/media-transport';
import { loadSharp } from '@/shared-utilities';

import type { TileRect } from './composite-layout';

export interface EncodedVideoStill {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
}

export interface CompositeTile {
  readonly rect: TileRect;
  /** Missing until the source delivers its first frame; drawn as a placeholder. */
  readonly frame?: RawVideoFrame;
  readonly label: string;
}

export interface VideoComposite {
  readonly width: number;
  readonly height: number;
  readonly tiles: readonly CompositeTile[];
}

/**
 * Draws each tile's frame upright and letterboxed into its rect, burns in
 * its label, and encodes the composite as one JPEG.
 */
export type VideoCompositeEncoder = (
  composite: VideoComposite,
  options: { quality: number },
) => Promise<EncodedVideoStill>;

const BACKGROUND = { r: 16, g: 16, b: 16 };
const PLACEHOLDER = '#2a2a2a';
const LABEL_HEIGHT = 22;
const LABEL_FONT_SIZE = 14;
const MAX_LABEL_CHARACTERS = 48;

/** Returns undefined when sharp's native addon is unavailable. */
export function createSharpVideoCompositeEncoder():
  | VideoCompositeEncoder
  | undefined {
  const sharp = loadSharp();
  if (!sharp) return undefined;
  return async (composite, options) => {
    const layers = await Promise.all(
      composite.tiles.map(async ({ rect, frame, label }) => {
        const overlay = {
          input: Buffer.from(tileOverlaySvg(rect, label, !frame)),
          left: rect.x,
          top: rect.y,
        };
        if (!frame) return [overlay];
        let pipeline = sharp(frame.data, {
          raw: { width: frame.width, height: frame.height, channels: 4 },
        });
        if (frame.rotation !== 0) pipeline = pipeline.rotate(frame.rotation);
        const { data, info } = await pipeline
          .resize({
            width: rect.width,
            height: rect.height,
            fit: 'contain',
            background: BACKGROUND,
          })
          .removeAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        return [
          {
            input: data,
            raw: {
              width: info.width,
              height: info.height,
              channels: info.channels,
            },
            left: rect.x,
            top: rect.y,
          },
          overlay,
        ];
      }),
    );
    const { data, info } = await sharp({
      create: {
        width: composite.width,
        height: composite.height,
        channels: 3,
        background: BACKGROUND,
      },
    })
      .composite(layers.flat())
      .jpeg({ quality: options.quality })
      .toBuffer({ resolveWithObject: true });
    return {
      data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      width: info.width,
      height: info.height,
    };
  };
}

/** A tile-sized SVG with the label in the bottom-left corner. */
export function tileOverlaySvg(
  rect: TileRect,
  label: string,
  placeholder: boolean,
): string {
  const text =
    label.length > MAX_LABEL_CHARACTERS
      ? `${label.slice(0, MAX_LABEL_CHARACTERS - 1)}…`
      : label;
  const labelWidth = Math.min(rect.width, 12 + text.length * 8);
  const top = Math.max(0, rect.height - LABEL_HEIGHT);
  const background = placeholder
    ? `<rect width="${rect.width}" height="${rect.height}" fill="${PLACEHOLDER}"/>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${rect.width}" height="${rect.height}">${background}<rect x="0" y="${top}" width="${labelWidth}" height="${LABEL_HEIGHT}" fill="#000" fill-opacity="0.6"/><text x="6" y="${top + LABEL_HEIGHT - 6}" font-family="sans-serif" font-size="${LABEL_FONT_SIZE}" fill="#fff">${escapeXml(text)}</text></svg>`;
}

function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (character) => {
    switch (character) {
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '&':
        return '&amp;';
      case '"':
        return '&quot;';
      default:
        return '&apos;';
    }
  });
}
