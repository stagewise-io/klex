import { readFileSync } from 'node:fs';
import type { Duplex } from 'node:stream';
import { deflateSync, gunzipSync, inflateSync } from 'node:zlib';

import type { StreamSink } from '../src/desktop/rfb/backend.js';
import { STREAM_TILE_SIZE } from '../src/desktop/rfb/backend.js';

export const ENC = {
  raw: 0,
  tight: 7,
  desktopSize: -223,
  extendedDesktopSize: -308,
  qemuKey: -258,
  clipboard: 0xc0a1e5ce | 0,
  quality: (level: number) => -32 + level,
  compress: (level: number) => -256 + level,
} as const;

export type TightKind = 'fill' | 'mono' | 'palette' | 'full' | 'jpeg';

export interface Frame {
  name: string;
  width: number;
  height: number;
  /** B, G, R, unused per pixel. */
  bgrx: Buffer;
  /** 0xRRGGBB per pixel. */
  pixels: Uint32Array;
  after?: string;
  tight: Record<string, TightKind>;
}

const FIXTURES = new URL('./fixtures/rfb/', import.meta.url);
const manifest = JSON.parse(
  readFileSync(new URL('frames.json', FIXTURES), 'utf8'),
) as {
  frames: Record<
    string,
    {
      width: number;
      height: number;
      after?: string;
      tight: Record<string, TightKind>;
    }
  >;
};

/** A frame from test/fixtures/rfb. */
export function loadFrame(name: string): Frame {
  const entry = manifest.frames[name];
  if (!entry) throw new Error(`no frame ${name}`);
  const bgrx = gunzipSync(readFileSync(new URL(`${name}.bgrx.gz`, FIXTURES)));
  if (bgrx.length !== entry.width * entry.height * 4)
    throw new Error(`frame ${name} has the wrong size`);
  const pixels = new Uint32Array(entry.width * entry.height);
  for (let i = 0; i < pixels.length; i++)
    pixels[i] = bgrx.readUInt32LE(i * 4) & 0xffffff;
  return { name, ...entry, bgrx, pixels };
}

export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8'));
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
  encoding: number;
  /** Decoded 0xRRGGBB pixels for Raw and lossless Tight rects. */
  pixels?: Uint32Array;
  jpeg?: Buffer;
  tight?: TightKind;
}

export type ServerMessage =
  | { type: 'update'; rects: Rect[] }
  | { type: 'bell' }
  | { type: 'cut'; text: string }
  | { type: 'clipboard'; flags: number; text?: string; sizes?: number[] };

/**
 * A minimal RFB 3.8 viewer for tests: it decodes Raw in the server's pixel
 * format and Tight as klex-machine sends it (zlib streams reset per rect).
 */
export class TestRfbClient {
  readonly socket: Duplex;
  width = 0;
  height = 0;
  name = '';
  /** 0xRRGGBB per pixel, kept current from Raw and lossless Tight rects. */
  screen = new Uint32Array(0);
  readonly messages: ServerMessage[] = [];
  #buffer = Buffer.alloc(0);
  #waiters: (() => void)[] = [];
  #closed = false;

  constructor(socket: Duplex) {
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      this.#wake();
    });
    socket.on('close', () => {
      this.#closed = true;
      this.#wake();
    });
    socket.on('error', () => undefined);
  }

  get closed(): boolean {
    return this.#closed;
  }

  async handshake(version = 'RFB 003.008\n'): Promise<void> {
    const server = (await this.read(12)).toString('latin1');
    if (server !== 'RFB 003.008\n') throw new Error(`server sent ${server}`);
    this.socket.write(version);
    if (version === 'RFB 003.003\n') {
      if ((await this.read(4)).readUInt32BE(0) !== 1)
        throw new Error('security');
    } else {
      const count = (await this.read(1))[0] as number;
      const types = [...(await this.read(count))];
      if (!types.includes(1)) throw new Error('no None security');
      this.socket.write(Buffer.from([1]));
      if (version === 'RFB 003.008\n' && (await this.read(4)).readUInt32BE(0))
        throw new Error('security failed');
    }
    this.socket.write(Buffer.from([1]));
    const init = await this.read(24);
    this.width = init.readUInt16BE(0);
    this.height = init.readUInt16BE(2);
    this.name = (await this.read(init.readUInt32BE(20))).toString('utf8');
    this.screen = new Uint32Array(this.width * this.height);
  }

  setEncodings(encodings: number[]): void {
    const out = Buffer.alloc(4 + encodings.length * 4);
    out[0] = 2;
    out.writeUInt16BE(encodings.length, 2);
    for (const [i, encoding] of encodings.entries())
      out.writeInt32BE(encoding, 4 + i * 4);
    this.socket.write(out);
  }

  request(incremental: boolean, rect = this.#full()): void {
    const out = Buffer.alloc(10);
    out[0] = 3;
    out[1] = incremental ? 1 : 0;
    out.writeUInt16BE(rect.x, 2);
    out.writeUInt16BE(rect.y, 4);
    out.writeUInt16BE(rect.width, 6);
    out.writeUInt16BE(rect.height, 8);
    this.socket.write(out);
  }

  key(down: boolean, keysym: number): void {
    const out = Buffer.alloc(8);
    out[0] = 4;
    out[1] = down ? 1 : 0;
    out.writeUInt32BE(keysym, 4);
    this.socket.write(out);
  }

  qemuKey(down: boolean, keysym: number, keycode: number): void {
    const out = Buffer.alloc(12);
    out[0] = 255;
    out.writeUInt16BE(down ? 1 : 0, 2);
    out.writeUInt32BE(keysym, 4);
    out.writeUInt32BE(keycode, 8);
    this.socket.write(out);
  }

  pointer(mask: number, x: number, y: number): void {
    const out = Buffer.alloc(6);
    out[0] = 5;
    out[1] = mask;
    out.writeUInt16BE(x, 2);
    out.writeUInt16BE(y, 4);
    this.socket.write(out);
  }

  /** Extended Clipboard message with the given flags and payload. */
  clipboard(flags: number, payload = Buffer.alloc(0)): void {
    const out = Buffer.alloc(12);
    out[0] = 6;
    out.writeInt32BE(-(4 + payload.length), 4);
    out.writeUInt32BE(flags >>> 0, 8);
    this.socket.write(Buffer.concat([out, payload]));
  }

  /** Provides UTF-8 text the way noVNC does. */
  provide(text: string): void {
    const data = Buffer.from(`${text.replace(/\r?\n/g, '\r\n')}\0`, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    this.clipboard((1 << 28) | 1, deflateSync(Buffer.concat([length, data])));
  }

  async next(
    match: (message: ServerMessage) => boolean = () => true,
  ): Promise<ServerMessage> {
    for (;;) {
      const message = await this.#message();
      this.messages.push(message);
      if (match(message)) return message;
    }
  }

  async nextUpdate(): Promise<Rect[]> {
    const message = await this.next((m) => m.type === 'update');
    return (message as { rects: Rect[] }).rects;
  }

  async read(length: number): Promise<Buffer> {
    while (this.#buffer.length < length) {
      if (this.#closed) throw new Error('connection closed');
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
    const out = this.#buffer.subarray(0, length);
    this.#buffer = this.#buffer.subarray(length);
    return out;
  }

  async #message(): Promise<ServerMessage> {
    const type = (await this.read(1))[0];
    switch (type) {
      case 0: {
        const count = (await this.read(3)).readUInt16BE(1);
        const rects: Rect[] = [];
        for (let i = 0; i < count; i++) rects.push(await this.#rect());
        return { type: 'update', rects };
      }
      case 2:
        return { type: 'bell' };
      case 3: {
        const length = (await this.read(7)).readInt32BE(3);
        if (length >= 0)
          return {
            type: 'cut',
            text: (await this.read(length)).toString('latin1'),
          };
        const payload = await this.read(-length);
        const flags = payload.readUInt32BE(0);
        const message: ServerMessage = { type: 'clipboard', flags };
        if (flags & (1 << 24)) {
          message.sizes = [];
          for (let at = 4; at < payload.length; at += 4)
            message.sizes.push(payload.readUInt32BE(at));
        } else if (flags & (1 << 28)) {
          const data = inflateSync(payload.subarray(4));
          const size = data.readUInt32BE(0);
          message.text = data
            .subarray(4, 4 + size)
            .toString('utf8')
            .replace(/\0+$/, '');
        }
        return message;
      }
      default:
        throw new Error(`unexpected server message ${type}`);
    }
  }

  async #rect(): Promise<Rect> {
    const header = await this.read(12);
    const rect: Rect = {
      x: header.readUInt16BE(0),
      y: header.readUInt16BE(2),
      width: header.readUInt16BE(4),
      height: header.readUInt16BE(6),
      encoding: header.readInt32BE(8),
    };
    const count = rect.width * rect.height;
    switch (rect.encoding) {
      case ENC.raw: {
        const data = await this.read(count * 4);
        rect.pixels = new Uint32Array(count);
        for (let i = 0; i < count; i++)
          rect.pixels[i] = data.readUInt32LE(i * 4) & 0xffffff;
        break;
      }
      case ENC.tight:
        await this.#tight(rect);
        break;
      case ENC.desktopSize:
        this.#resize(rect.width, rect.height);
        return rect;
      case ENC.extendedDesktopSize: {
        const screens = (await this.read(4))[0] as number;
        await this.read(16 * screens);
        if (rect.y === 0) this.#resize(rect.width, rect.height);
        return rect;
      }
      default:
        return rect;
    }
    if (rect.pixels) {
      for (let row = 0; row < rect.height; row++) {
        this.screen.set(
          rect.pixels.subarray(row * rect.width, (row + 1) * rect.width),
          (rect.y + row) * this.width + rect.x,
        );
      }
    }
    return rect;
  }

  async #tight(rect: Rect): Promise<void> {
    const count = rect.width * rect.height;
    const control = (await this.read(1))[0] as number;
    const kind = control >> 4;
    if (kind === 8) {
      rect.tight = 'fill';
      const [r, g, b] = await this.read(3);
      rect.pixels = new Uint32Array(count).fill(
        ((r as number) << 16) | ((g as number) << 8) | (b as number),
      );
      return;
    }
    if (kind === 9) {
      rect.tight = 'jpeg';
      rect.jpeg = await this.read(await this.#compactLength());
      return;
    }
    if (kind > 7) throw new Error(`unexpected Tight control ${control}`);
    const stream = kind & 3;
    if (!(control & (1 << stream))) throw new Error('zlib stream not reset');
    let palette: number[] | undefined;
    if (kind & 4) {
      const filter = (await this.read(1))[0];
      if (filter !== 1) throw new Error(`unexpected Tight filter ${filter}`);
      const size = ((await this.read(1))[0] as number) + 1;
      const colors = await this.read(size * 3);
      palette = [];
      for (let i = 0; i < size; i++) {
        palette.push(
          ((colors[i * 3] as number) << 16) |
            ((colors[i * 3 + 1] as number) << 8) |
            (colors[i * 3 + 2] as number),
        );
      }
    }
    rect.tight = !palette ? 'full' : palette.length === 2 ? 'mono' : 'palette';
    const rowBytes = (rect.width + 7) >> 3;
    const length = palette
      ? palette.length === 2
        ? rowBytes * rect.height
        : count
      : count * 3;
    const data =
      length < 12
        ? await this.read(length)
        : inflateSync(await this.read(await this.#compactLength()));
    if (data.length !== length)
      throw new Error('Tight data has the wrong size');
    rect.pixels = new Uint32Array(count);
    for (let i = 0; i < count; i++) {
      if (!palette) {
        rect.pixels[i] =
          ((data[i * 3] as number) << 16) |
          ((data[i * 3 + 1] as number) << 8) |
          (data[i * 3 + 2] as number);
      } else if (palette.length === 2) {
        const x = i % rect.width;
        const y = Math.floor(i / rect.width);
        const bit =
          ((data[y * rowBytes + (x >> 3)] as number) >> (7 - (x & 7))) & 1;
        rect.pixels[i] = palette[bit] as number;
      } else {
        rect.pixels[i] = palette[data[i] as number] as number;
      }
    }
  }

  async #compactLength(): Promise<number> {
    let length = 0;
    for (let i = 0; i < 3; i++) {
      const byte = (await this.read(1))[0] as number;
      length |= (i === 2 ? byte : byte & 0x7f) << (7 * i);
      if (i < 2 && !(byte & 0x80)) break;
    }
    return length;
  }

  #resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.screen = new Uint32Array(width * height);
  }

  #full() {
    return { x: 0, y: 0, width: this.width, height: this.height };
  }

  #wake(): void {
    for (const waiter of this.#waiters.splice(0)) waiter();
  }
}

/**
 * A capture driven by the test: `show` sends the tiles of a frame that differ
 * from the last one, after a size message when the size changed.
 */
export class SyntheticCapture {
  sink: StreamSink | undefined;
  starts = 0;
  stops = 0;
  quality: number | undefined;
  refreshes = 0;
  readonly input: string[] = [];
  #frame: Frame;
  #previous: Frame | undefined;

  constructor(frame: Frame) {
    this.#frame = frame;
  }

  backend() {
    return {
      start: (sink: StreamSink) => {
        this.sink = sink;
        this.starts++;
        this.#previous = undefined;
        queueMicrotask(() => this.show(this.#frame));
        return {
          setQuality: (quality: number | undefined) => {
            this.quality = quality;
          },
          refresh: () => {
            this.refreshes++;
          },
          move: (x: number, y: number) => this.input.push(`move ${x} ${y}`),
          button: (button: string, down: boolean, x: number, y: number) =>
            this.input.push(`button ${button} ${down ? 1 : 0} ${x} ${y}`),
          wheel: (direction: string, x: number, y: number) =>
            this.input.push(`wheel ${direction} ${x} ${y}`),
          key: (key: { down: boolean; keysym: number; keycode: number }) =>
            this.input.push(
              `key ${key.down ? 1 : 0} ${key.keysym.toString(16)} ${key.keycode}`,
            ),
          setClipboard: (text: string) => this.input.push(`clipboard ${text}`),
          stop: () => {
            this.stops++;
            this.sink = undefined;
          },
        };
      },
    };
  }

  /** A frame filled with one colour. */
  static solid(width: number, height: number, color: number): Frame {
    const bgrx = Buffer.alloc(width * height * 4);
    const pixels = new Uint32Array(width * height).fill(color);
    for (let i = 0; i < pixels.length; i++) bgrx.writeUInt32LE(color, i * 4);
    return { name: `solid-${color}`, width, height, bgrx, pixels, tight: {} };
  }

  show(frame: Frame): void {
    this.#frame = frame;
    const sink = this.sink;
    if (!sink) return;
    const previous =
      this.#previous &&
      this.#previous.width === frame.width &&
      this.#previous.height === frame.height
        ? this.#previous
        : undefined;
    if (!previous) sink.resize({ width: frame.width, height: frame.height });
    const size = STREAM_TILE_SIZE;
    for (let ty = 0; ty < frame.height; ty += size) {
      for (let tx = 0; tx < frame.width; tx += size) {
        const w = Math.min(size, frame.width - tx);
        const h = Math.min(size, frame.height - ty);
        const rows: Buffer[] = [];
        let changed = !previous;
        for (let y = 0; y < h; y++) {
          const at = ((ty + y) * frame.width + tx) * 4;
          const row = frame.bgrx.subarray(at, at + w * 4);
          if (previous && !row.equals(previous.bgrx.subarray(at, at + w * 4)))
            changed = true;
          rows.push(row);
        }
        if (changed)
          sink.raw({ x: tx, y: ty, width: w, height: h }, Buffer.concat(rows));
      }
    }
    sink.frame();
    this.#previous = frame;
  }
}
