import { inflateSync } from 'node:zlib';

export const FAKE_SCREEN = { width: 1600, height: 1000 };
export const FAKE_HINT = 'The fake desktop is unavailable.';

/** The fake desktop's colour at a pixel, as 0xRRGGBB. */
export function fakePixel(x: number, y: number): number {
  return (
    ((x & 0xff) << 16) | ((y & 0xff) << 8) | (((x >> 4) ^ (y >> 4)) & 0xff)
  );
}

export interface DecodedImage {
  width: number;
  height: number;
  /** 0xRRGGBB at a pixel. */
  pixel(x: number, y: number): number;
}

const PNG_CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Decodes a non-interlaced PNG: 8-bit grey, RGB or RGBA, or a palette. */
export function decodePng(png: Buffer): DecodedImage {
  if (png.readUInt32BE(0) !== 0x89504e47) throw new Error('Not a PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  let depth = 8;
  let colourType = 2;
  let palette = Buffer.alloc(0);
  const data: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('latin1', offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8]!;
      colourType = body[9]!;
      if (PNG_CHANNELS[colourType] === undefined)
        throw new Error('Unsupported PNG colour type');
      if (depth !== 8 && !(depth < 8 && (colourType === 0 || colourType === 3)))
        throw new Error('Unsupported PNG bit depth');
      if (body[12] !== 0) throw new Error('Unsupported PNG interlacing');
    } else if (type === 'PLTE') palette = Buffer.from(body);
    else if (type === 'IDAT') data.push(body);
    offset += 12 + length;
  }
  const channels = PNG_CHANNELS[colourType]!;
  const raw = inflateSync(Buffer.concat(data));
  const bytesPerPixel = Math.max(1, (channels * depth) / 8);
  const stride = Math.ceil((width * channels * depth) / 8);
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const previous =
      y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : undefined;
    for (let i = 0; i < stride; i++) {
      const left = i >= bytesPerPixel ? out[i - bytesPerPixel]! : 0;
      const up = previous?.[i] ?? 0;
      const corner =
        i >= bytesPerPixel ? (previous?.[i - bytesPerPixel] ?? 0) : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) {
        const estimate = left + up - corner;
        const [a, b, c] = [
          Math.abs(estimate - left),
          Math.abs(estimate - up),
          Math.abs(estimate - corner),
        ];
        predicted = a <= b && a <= c ? left : b <= c ? up : corner;
      }
      out[i] = (line[i]! + predicted) & 0xff;
    }
  }
  const sample = (x: number, y: number, channel: number) => {
    const bit = (x * channels + channel) * depth;
    const byte = pixels[y * stride + (bit >> 3)]!;
    return depth === 8
      ? byte
      : (byte >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
  };
  return {
    width,
    height,
    pixel: (x, y) => {
      if (colourType === 3) {
        const at = sample(x, y, 0) * 3;
        return (
          (palette[at]! << 16) | (palette[at + 1]! << 8) | palette[at + 2]!
        );
      }
      if (colourType === 0 || colourType === 4) {
        const grey = Math.round((sample(x, y, 0) * 255) / ((1 << depth) - 1));
        return (grey << 16) | (grey << 8) | grey;
      }
      return (sample(x, y, 0) << 16) | (sample(x, y, 1) << 8) | sample(x, y, 2);
    },
  };
}

/** Pixel mismatches between `image` and `expected`, at most `limit`. */
export function mismatches(
  image: DecodedImage,
  expected: (x: number, y: number) => number,
  limit = 5,
): string[] {
  const found: string[] = [];
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++) {
      const actual = image.pixel(x, y);
      const wanted = expected(x, y);
      if (actual !== wanted) {
        found.push(
          `(${x}, ${y}): ${actual.toString(16)} != ${wanted.toString(16)}`,
        );
        if (found.length >= limit) return found;
      }
    }
  return found;
}

/** The fake capture's nearest-neighbour sample of `region` at `size`. */
export function fakeCapture(
  region: { x: number; y: number; width: number; height: number },
  size: { width: number; height: number },
): (x: number, y: number) => number {
  return (x, y) =>
    fakePixel(
      region.x + Math.floor((x * region.width) / size.width),
      region.y + Math.floor((y * region.height) / size.height),
    );
}

export interface FramebufferRect {
  x: number;
  y: number;
  width: number;
  height: number;
  encoding: number;
}

/**
 * A minimal RFB 3.8 viewer over a byte source: no security, 32-bit
 * little-endian true colour, raw encoding only.
 */
export class RfbViewer {
  #offset = 0;
  width = 0;
  height = 0;
  name = '';
  readonly clipboard: string[] = [];
  /** 0xRRGGBB pixels of the last full update. */
  pixels = new Uint32Array(0);

  constructor(
    private readonly received: () => Buffer,
    private readonly send: (data: Buffer) => void,
  ) {}

  async #read(count: number): Promise<Buffer> {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const data = this.received();
      if (data.length >= this.#offset + count) {
        const out = data.subarray(this.#offset, this.#offset + count);
        this.#offset += count;
        return Buffer.from(out);
      }
      if (Date.now() > deadline)
        throw new Error(`Timed out reading ${count} RFB bytes`);
      await new Promise((done) => setTimeout(done, 10));
    }
  }

  async handshake(): Promise<void> {
    const version = (await this.#read(12)).toString('latin1');
    if (version !== 'RFB 003.008\n')
      throw new Error(`Unexpected version ${JSON.stringify(version)}`);
    this.send(Buffer.from('RFB 003.008\n', 'latin1'));
    const count = (await this.#read(1))[0]!;
    const types = [...(await this.#read(count))];
    if (!types.includes(1)) throw new Error(`No None security in ${types}`);
    this.send(Buffer.from([1]));
    const result = (await this.#read(4)).readUInt32BE(0);
    if (result !== 0) throw new Error(`Security failed: ${result}`);
    this.send(Buffer.from([1]));
    const init = await this.#read(24);
    this.width = init.readUInt16BE(0);
    this.height = init.readUInt16BE(2);
    this.name = (await this.#read(init.readUInt32BE(20))).toString('utf8');
    this.pixels = new Uint32Array(this.width * this.height);
    const format = Buffer.alloc(20);
    format[0] = 0;
    format.writeUInt8(32, 4);
    format.writeUInt8(24, 5);
    format.writeUInt8(0, 6);
    format.writeUInt8(1, 7);
    format.writeUInt16BE(255, 8);
    format.writeUInt16BE(255, 10);
    format.writeUInt16BE(255, 12);
    format.writeUInt8(16, 14);
    format.writeUInt8(8, 15);
    format.writeUInt8(0, 16);
    this.send(format);
    const encodings = Buffer.alloc(8);
    encodings[0] = 2;
    encodings.writeUInt16BE(1, 2);
    encodings.writeInt32BE(0, 4);
    this.send(encodings);
  }

  requestUpdate(incremental: boolean): void {
    const request = Buffer.alloc(10);
    request[0] = 3;
    request[1] = incremental ? 1 : 0;
    request.writeUInt16BE(this.width, 6);
    request.writeUInt16BE(this.height, 8);
    this.send(request);
  }

  /** Reads server messages until a framebuffer update arrives. */
  async update(): Promise<FramebufferRect[]> {
    for (;;) {
      const type = (await this.#read(1))[0]!;
      if (type === 2) continue;
      if (type === 3) {
        const header = await this.#read(7);
        const length = header.readUInt32BE(3);
        this.clipboard.push((await this.#read(length)).toString('latin1'));
        continue;
      }
      if (type !== 0) throw new Error(`Unexpected RFB message ${type}`);
      const count = (await this.#read(3)).readUInt16BE(1);
      const rects: FramebufferRect[] = [];
      for (let index = 0; index < count; index++) {
        const header = await this.#read(12);
        const rect = {
          x: header.readUInt16BE(0),
          y: header.readUInt16BE(2),
          width: header.readUInt16BE(4),
          height: header.readUInt16BE(6),
          encoding: header.readInt32BE(8),
        };
        rects.push(rect);
        if (rect.encoding !== 0)
          throw new Error(`Unexpected encoding ${rect.encoding}`);
        const data = await this.#read(rect.width * rect.height * 4);
        for (let row = 0; row < rect.height; row++)
          for (let column = 0; column < rect.width; column++)
            this.pixels[(rect.y + row) * this.width + rect.x + column] =
              data.readUInt32LE((row * rect.width + column) * 4) & 0xffffff;
      }
      return rects;
    }
  }

  pointer(mask: number, x: number, y: number): void {
    const event = Buffer.alloc(6);
    event[0] = 5;
    event[1] = mask;
    event.writeUInt16BE(x, 2);
    event.writeUInt16BE(y, 4);
    this.send(event);
  }

  key(down: boolean, keysym: number): void {
    const event = Buffer.alloc(8);
    event[0] = 4;
    event[1] = down ? 1 : 0;
    event.writeUInt32BE(keysym, 4);
    this.send(event);
  }
}
