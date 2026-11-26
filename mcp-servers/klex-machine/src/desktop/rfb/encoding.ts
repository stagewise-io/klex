import { deflateSync } from 'node:zlib';

import type { Region } from '../provider.js';

export interface PixelFormat {
  bitsPerPixel: number;
  depth: number;
  bigEndian: boolean;
  trueColor: boolean;
  redMax: number;
  greenMax: number;
  blueMax: number;
  redShift: number;
  greenShift: number;
  blueShift: number;
}

/** BGRX in memory: 32-bit little-endian 0x00RRGGBB, what captures produce. */
export const SERVER_PIXEL_FORMAT: PixelFormat = {
  bitsPerPixel: 32,
  depth: 24,
  bigEndian: false,
  trueColor: true,
  redMax: 255,
  greenMax: 255,
  blueMax: 255,
  redShift: 16,
  greenShift: 8,
  blueShift: 0,
};

export const ENCODING_RAW = 0;
export const ENCODING_TIGHT = 7;

const TIGHT_FILL = 0x80;
const TIGHT_JPEG = 0x90;
const TIGHT_EXPLICIT_FILTER = 0x40;
const TIGHT_FILTER_PALETTE = 1;
const TIGHT_MIN_TO_COMPRESS = 12;
const TIGHT_MAX_PALETTE = 256;

export function writePixelFormat(format: PixelFormat): Buffer {
  const out = Buffer.alloc(16);
  out[0] = format.bitsPerPixel;
  out[1] = format.depth;
  out[2] = format.bigEndian ? 1 : 0;
  out[3] = format.trueColor ? 1 : 0;
  out.writeUInt16BE(format.redMax, 4);
  out.writeUInt16BE(format.greenMax, 6);
  out.writeUInt16BE(format.blueMax, 8);
  out[10] = format.redShift;
  out[11] = format.greenShift;
  out[12] = format.blueShift;
  return out;
}

/** Reads the 16-byte PIXEL_FORMAT at `offset`. */
export function readPixelFormat(data: Buffer, offset: number): PixelFormat {
  return {
    bitsPerPixel: data[offset] as number,
    depth: data[offset + 1] as number,
    bigEndian: data[offset + 2] !== 0,
    trueColor: data[offset + 3] !== 0,
    redMax: data.readUInt16BE(offset + 4),
    greenMax: data.readUInt16BE(offset + 6),
    blueMax: data.readUInt16BE(offset + 8),
    redShift: data[offset + 10] as number,
    greenShift: data[offset + 11] as number,
    blueShift: data[offset + 12] as number,
  };
}

/** Why a client pixel format cannot be served, or undefined when it can. */
export function unsupportedPixelFormat(
  format: PixelFormat,
): string | undefined {
  if (!format.trueColor) return 'colour-map pixel formats are not supported';
  if (![8, 16, 32].includes(format.bitsPerPixel)) {
    return `${format.bitsPerPixel} bits per pixel is not supported`;
  }
  for (const [max, shift] of [
    [format.redMax, format.redShift],
    [format.greenMax, format.greenShift],
    [format.blueMax, format.blueShift],
  ] as const) {
    if (max === 0 || max > 0xffff || shift + bitLength(max) > 32) {
      return 'the pixel format has an invalid colour channel';
    }
  }
  return undefined;
}

/** Tight sends 3-byte RGB pixels only for 8-bit channels in 32 bits. */
export function tightCompatible(format: PixelFormat): boolean {
  return (
    format.bitsPerPixel === 32 &&
    format.depth === 24 &&
    format.trueColor &&
    format.redMax === 255 &&
    format.greenMax === 255 &&
    format.blueMax === 255
  );
}

export function pixelFormatKey(format: PixelFormat): string {
  return writePixelFormat(format).toString('hex');
}

export function rectHeader(rect: Region, encoding: number): Buffer {
  const out = Buffer.alloc(12);
  out.writeUInt16BE(rect.x, 0);
  out.writeUInt16BE(rect.y, 2);
  out.writeUInt16BE(rect.width, 4);
  out.writeUInt16BE(rect.height, 6);
  out.writeInt32BE(encoding, 8);
  return out;
}

/** Raw encoding: BGRX pixels converted to the client's pixel format. */
export function encodeRaw(bgrx: Buffer, format: PixelFormat): Buffer {
  const count = bgrx.length >> 2;
  const bytes = format.bitsPerPixel >> 3;
  const out = Buffer.alloc(count * bytes);
  const red = channelTable(format.redMax, format.redShift);
  const green = channelTable(format.greenMax, format.greenShift);
  const blue = channelTable(format.blueMax, format.blueShift);
  for (let i = 0; i < count; i++) {
    const at = i << 2;
    const value =
      ((red[bgrx[at + 2] as number] as number) |
        (green[bgrx[at + 1] as number] as number) |
        (blue[bgrx[at] as number] as number)) >>>
      0;
    const to = i * bytes;
    if (bytes === 4) {
      if (format.bigEndian) out.writeUInt32BE(value, to);
      else out.writeUInt32LE(value, to);
    } else if (bytes === 2) {
      if (format.bigEndian) out.writeUInt16BE(value & 0xffff, to);
      else out.writeUInt16LE(value & 0xffff, to);
    } else {
      out[to] = value & 0xff;
    }
  }
  return out;
}

/**
 * Tight encoding of BGRX pixels without JPEG: a fill for one colour, an
 * indexed palette up to 256 colours, full RGB otherwise. Every compressed rect
 * resets its zlib stream, so the output depends on the pixels alone and can be
 * shared between viewers.
 */
export function encodeTight(
  bgrx: Buffer,
  width: number,
  height: number,
  zlibLevel: number,
): Buffer {
  const count = width * height;
  const palette = new Map<number, number>();
  const indices = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const at = i << 2;
    const color =
      ((bgrx[at + 2] as number) << 16) |
      ((bgrx[at + 1] as number) << 8) |
      (bgrx[at] as number);
    let index = palette.get(color);
    if (index === undefined) {
      if (palette.size === TIGHT_MAX_PALETTE) {
        palette.clear();
        break;
      }
      index = palette.size;
      palette.set(color, index);
    }
    indices[i] = index;
  }
  if (palette.size === 1) {
    const value = palette.keys().next().value as number;
    return Buffer.from([
      TIGHT_FILL,
      (value >> 16) & 0xff,
      (value >> 8) & 0xff,
      value & 0xff,
    ]);
  }
  if (palette.size > 1) {
    const stream = palette.size === 2 ? 1 : 2;
    const colors = Buffer.alloc(palette.size * 3);
    for (const [color, index] of palette) {
      colors[index * 3] = (color >> 16) & 0xff;
      colors[index * 3 + 1] = (color >> 8) & 0xff;
      colors[index * 3 + 2] = color & 0xff;
    }
    let data: Buffer;
    if (palette.size === 2) {
      const rowBytes = (width + 7) >> 3;
      data = Buffer.alloc(rowBytes * height);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (indices[y * width + x]) {
            const at = y * rowBytes + (x >> 3);
            data[at] = (data[at] as number) | (0x80 >> (x & 7));
          }
        }
      }
    } else {
      data = Buffer.from(indices.buffer, indices.byteOffset, count);
    }
    return Buffer.concat([
      Buffer.from([
        (stream << 4) | TIGHT_EXPLICIT_FILTER | (1 << stream),
        TIGHT_FILTER_PALETTE,
        palette.size - 1,
      ]),
      colors,
      tightData(data, zlibLevel),
    ]);
  }
  const rgb = Buffer.alloc(count * 3);
  for (let i = 0; i < count; i++) {
    const from = i << 2;
    const to = i * 3;
    rgb[to] = bgrx[from + 2] as number;
    rgb[to + 1] = bgrx[from + 1] as number;
    rgb[to + 2] = bgrx[from] as number;
  }
  return Buffer.concat([Buffer.from([1]), tightData(rgb, zlibLevel)]);
}

export function encodeTightJpeg(jpeg: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from([TIGHT_JPEG]),
    compactLength(jpeg.length),
    jpeg,
  ]);
}

function tightData(data: Buffer, zlibLevel: number): Buffer {
  if (data.length < TIGHT_MIN_TO_COMPRESS) return data;
  const compressed = deflateSync(data, { level: zlibLevel });
  return Buffer.concat([compactLength(compressed.length), compressed]);
}

export function compactLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  if (length < 0x4000)
    return Buffer.from([(length & 0x7f) | 0x80, length >> 7]);
  if (length < 0x400000) {
    return Buffer.from([
      (length & 0x7f) | 0x80,
      ((length >> 7) & 0x7f) | 0x80,
      length >> 14,
    ]);
  }
  throw new RangeError(`Tight data of ${length} bytes is too long`);
}

/** Maps Tight's 0 to 9 quality levels to JPEG quality, as TigerVNC does. */
export const JPEG_QUALITY_BY_LEVEL = [15, 29, 41, 42, 62, 77, 79, 86, 92, 100];

function channelTable(max: number, shift: number): Uint32Array {
  const table = new Uint32Array(256);
  for (let value = 0; value < 256; value++) {
    table[value] = (Math.round((value * max) / 255) << shift) >>> 0;
  }
  return table;
}

function bitLength(value: number): number {
  return value === 0 ? 0 : 32 - Math.clz32(value);
}
