import type { Duplex } from 'node:stream';

import type { Region } from '../provider.js';
import {
  MAX_RFB_CLIENT_MESSAGE_BYTES,
  RfbProtocolError,
} from '../rfb-filter.js';
import type { StreamButton, StreamKey, StreamWheel } from './backend.js';
import {
  CLIPBOARD_TEXT,
  clipboardCaps,
  clipboardNotify,
  clipboardProvide,
  clipboardRequest,
  decodeLegacyCutText,
  EXTENDED_CLIPBOARD,
  legacyCutText,
  parseClipboardMessage,
} from './clipboard.js';
import {
  ENCODING_RAW,
  ENCODING_TIGHT,
  encodeRaw,
  encodeTight,
  encodeTightJpeg,
  JPEG_QUALITY_BY_LEVEL,
  type PixelFormat,
  pixelFormatKey,
  readPixelFormat,
  rectHeader,
  SERVER_PIXEL_FORMAT,
  tightCompatible,
  unsupportedPixelFormat,
  writePixelFormat,
} from './encoding.js';
import type { Framebuffer, Tile } from './framebuffer.js';

const SERVER_VERSION = Buffer.from('RFB 003.008\n', 'latin1');
const SECURITY_NONE = 1;

const QUALITY_LEVEL_0 = -32;
const COMPRESS_LEVEL_0 = -256;
const DESKTOP_SIZE = -223;
const QEMU_EXTENDED_KEY = -258;
const EXTENDED_DESKTOP_SIZE = -308;
const DEFAULT_ZLIB_LEVEL = 6;

/**
 * How long input waits for clipboard text a viewer announced. Viewers paste
 * by announcing their clipboard and pressing V right away, so V must not
 * reach the desktop before the text it pastes.
 */
export const CLIPBOARD_WAIT_MS = 1_000;
const MAX_HELD_INPUT = 1_000;

const BUTTONS: [number, StreamButton][] = [
  [1, 'left'],
  [2, 'middle'],
  [4, 'right'],
];
const WHEELS: [number, StreamWheel][] = [
  [8, 'up'],
  [16, 'down'],
  [32, 'left'],
  [64, 'right'],
];

/** What a session needs from the server that owns the capture. */
export interface SessionHost {
  readonly name: string;
  /** Resolves with the first framebuffer of the running capture. */
  ready(): Promise<Framebuffer>;
  framebuffer(): Framebuffer | undefined;
  clipboardText(): string | undefined;
  move(x: number, y: number): void;
  button(button: StreamButton, down: boolean, x: number, y: number): void;
  wheel(direction: StreamWheel, x: number, y: number): void;
  key(key: StreamKey): void;
  setClipboard(text: string): void;
  /** The session's JPEG support or quality changed. */
  qualityChanged(): void;
  closed(session: RfbSession): void;
}

type Phase =
  | 'version'
  | 'security'
  | 'init'
  | 'waiting'
  | 'messages'
  | 'closed';

/**
 * Server half of one RFB 3.3/3.7/3.8 viewer with security None, always
 * shared. Updates follow the viewer's requests and carry only tiles changed
 * since the viewer last received them, so a slow viewer skips frames instead
 * of queueing them. Input is passed on as is: the stream relays already drop
 * it for viewers without control.
 */
export class RfbSession {
  readonly #socket: Duplex;
  readonly #host: SessionHost;
  #phase: Phase = 'version';
  #minor = 8;
  #buffer: Buffer = Buffer.alloc(0);
  #format: PixelFormat = SERVER_PIXEL_FORMAT;
  #encodings = new Set<number>();
  #resizedEarly = false;
  #negotiated = false;
  #jpegLevel: number | undefined;
  #zlibLevel = DEFAULT_ZLIB_LEVEL;
  #request: { incremental: boolean; rect: Region } | undefined;
  #sent = new Uint32Array(0);
  #draining = false;
  #pendingExtendedSize: { reason: number; status: number } | undefined;
  #pendingDesktopSize = false;
  #pendingQemu = false;
  #announcedExtendedSize = false;
  #announcedQemu = false;
  #sentClipboardCaps = false;
  readonly #keys = new Map<string, StreamKey>();
  #buttons = 0;
  #pointer = { x: -1, y: -1 };
  #held:
    | { timer: ReturnType<typeof setTimeout>; queue: (() => void)[] }
    | undefined;

  constructor(socket: Duplex, host: SessionHost) {
    this.#socket = socket;
    this.#host = host;
    socket.on('data', (chunk: Buffer) => this.#receive(chunk));
    socket.on('end', () => this.close());
    socket.on('close', () => this.close());
    socket.on('error', () => this.close());
    socket.write(SERVER_VERSION);
  }

  /**
   * JPEG quality the viewer accepts: undefined when it takes no JPEG, null
   * until it has sent its encodings.
   */
  get jpegQuality(): number | undefined | null {
    if (!this.#negotiated) return null;
    if (!this.#jpegAllowed()) return undefined;
    return JPEG_QUALITY_BY_LEVEL[this.#jpegLevel as number];
  }

  /**
   * The framebuffer was replaced by one of another size. The new size goes
   * out with the first frame committed to it.
   */
  resized(framebuffer: Framebuffer): void {
    if (this.#phase !== 'messages') return;
    this.#sent = new Uint32Array(framebuffer.tiles.length);
    // Until SetEncodings arrives the viewer's resize support is unknown.
    if (this.#negotiated) this.#followResize();
    else this.#resizedEarly = true;
  }

  #followResize(): void {
    if (this.#encodings.has(EXTENDED_DESKTOP_SIZE)) {
      this.#pendingExtendedSize = { reason: 0, status: 0 };
    } else if (this.#encodings.has(DESKTOP_SIZE)) {
      this.#pendingDesktopSize = true;
    } else {
      this.close(new RfbProtocolError('The viewer cannot follow a resize'));
    }
  }

  /** New tiles were committed. */
  update(): void {
    if (this.#phase !== 'messages' || !this.#request || this.#draining) return;
    const framebuffer = this.#host.framebuffer();
    if (!framebuffer) return;
    const rects: Buffer[] = [];
    if (this.#pendingExtendedSize) {
      rects.push(extendedDesktopSize(framebuffer, this.#pendingExtendedSize));
    } else if (this.#pendingDesktopSize) {
      rects.push(
        rectHeader(
          { x: 0, y: 0, width: framebuffer.width, height: framebuffer.height },
          DESKTOP_SIZE,
        ),
      );
    }
    if (this.#pendingQemu) {
      rects.push(
        rectHeader({ x: 0, y: 0, width: 0, height: 0 }, QEMU_EXTENDED_KEY),
      );
    }
    // A request made before a resize covers the old size.
    const rect =
      this.#pendingExtendedSize?.reason === 0 || this.#pendingDesktopSize
        ? { x: 0, y: 0, width: framebuffer.width, height: framebuffer.height }
        : this.#request.rect;
    const jpeg = this.#jpegAllowed();
    for (let index = 0; index < framebuffer.tiles.length; index++) {
      const tile = framebuffer.tiles[index] as Tile;
      if (
        tile.version === 0 ||
        tile.version === this.#sent[index] ||
        (tile.jpeg && !jpeg) ||
        !intersects(tile.rect, rect)
      )
        continue;
      rects.push(this.#encode(framebuffer, tile));
      this.#sent[index] = tile.version;
    }
    if (rects.length === 0) return;
    this.#pendingExtendedSize = undefined;
    this.#pendingDesktopSize = false;
    this.#pendingQemu = false;
    this.#request = undefined;
    const header = Buffer.alloc(4);
    header.writeUInt16BE(rects.length, 2);
    this.#write(Buffer.concat([header, ...rects]));
  }

  /** The desktop's clipboard changed. */
  clipboardChanged(): void {
    if (this.#phase !== 'messages') return;
    if (this.#encodings.has(EXTENDED_CLIPBOARD)) {
      this.#write(clipboardNotify(true));
      return;
    }
    const text = this.#host.clipboardText();
    if (text !== undefined) this.#write(legacyCutText(text));
  }

  close(error?: Error): void {
    if (this.#phase === 'closed') return;
    this.#phase = 'closed';
    if (this.#held) clearTimeout(this.#held.timer);
    this.#held = undefined;
    for (const key of this.#keys.values())
      this.#host.key({ ...key, down: false });
    this.#keys.clear();
    for (const [bit, button] of BUTTONS) {
      if (this.#buttons & bit)
        this.#host.button(button, false, this.#pointer.x, this.#pointer.y);
    }
    this.#buttons = 0;
    this.#host.closed(this);
    this.#socket.destroy(error);
  }

  #write(data: Buffer): void {
    if (this.#phase === 'closed') return;
    if (this.#socket.write(data) || this.#draining) return;
    this.#draining = true;
    this.#socket.once('drain', () => {
      this.#draining = false;
      this.update();
    });
  }

  #receive(chunk: Buffer): void {
    if (this.#phase === 'closed') return;
    this.#buffer =
      this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    try {
      this.#process();
    } catch (error) {
      this.close(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #process(): void {
    for (;;) {
      const length = this.#nextLength();
      if (length === undefined || this.#buffer.length < length) return;
      const message = this.#buffer.subarray(0, length);
      this.#buffer = this.#buffer.subarray(length);
      this.#accept(message);
      if (this.#phase === 'waiting' || this.#phase === 'closed') return;
    }
  }

  #nextLength(): number | undefined {
    switch (this.#phase) {
      case 'version':
        return 12;
      case 'security':
      case 'init':
        return 1;
      case 'waiting':
      case 'closed':
        return undefined;
      case 'messages':
        return messageLength(this.#buffer);
    }
  }

  #accept(message: Buffer): void {
    switch (this.#phase) {
      case 'version': {
        const match = /^RFB 003\.(\d{3})\n$/.exec(message.toString('latin1'));
        if (!match) throw new RfbProtocolError('Invalid RFB protocol version');
        const minor = Number(match[1]);
        this.#minor = minor >= 8 ? 8 : minor === 7 ? 7 : 3;
        if (this.#minor === 3) {
          const security = Buffer.alloc(4);
          security.writeUInt32BE(SECURITY_NONE, 0);
          this.#socket.write(security);
          this.#phase = 'init';
        } else {
          this.#socket.write(Buffer.from([1, SECURITY_NONE]));
          this.#phase = 'security';
        }
        return;
      }
      case 'security': {
        if (message[0] !== SECURITY_NONE) {
          if (this.#minor === 8) {
            const reason = Buffer.from('Only security type None is offered');
            const failure = Buffer.alloc(8);
            failure.writeUInt32BE(1, 0);
            failure.writeUInt32BE(reason.length, 4);
            this.#socket.write(Buffer.concat([failure, reason]));
          }
          throw new RfbProtocolError('Unsupported RFB security type');
        }
        if (this.#minor === 8) this.#socket.write(Buffer.alloc(4));
        this.#phase = 'init';
        return;
      }
      case 'init':
        this.#phase = 'waiting';
        this.#host.ready().then(
          (framebuffer) => this.#start(framebuffer),
          (error: unknown) =>
            this.close(
              error instanceof Error ? error : new Error(String(error)),
            ),
        );
        return;
      case 'messages':
        this.#message(message);
        return;
      default:
        return;
    }
  }

  #start(ready: Framebuffer): void {
    if (this.#phase !== 'waiting') return;
    const framebuffer = this.#host.framebuffer() ?? ready;
    const name = Buffer.from(this.#host.name, 'utf8');
    const init = Buffer.alloc(24);
    init.writeUInt16BE(framebuffer.width, 0);
    init.writeUInt16BE(framebuffer.height, 2);
    writePixelFormat(SERVER_PIXEL_FORMAT).copy(init, 4);
    init.writeUInt32BE(name.length, 20);
    this.#socket.write(Buffer.concat([init, name]));
    this.#sent = new Uint32Array(framebuffer.tiles.length);
    this.#phase = 'messages';
    this.#receive(Buffer.alloc(0));
  }

  #message(message: Buffer): void {
    switch (message[0]) {
      case 0: {
        const format = readPixelFormat(message, 4);
        const problem = unsupportedPixelFormat(format);
        if (problem) throw new RfbProtocolError(`SetPixelFormat: ${problem}`);
        this.#format = format;
        this.#host.qualityChanged();
        return;
      }
      case 2:
        this.#setEncodings(message);
        return;
      case 3:
        this.#updateRequest(message);
        return;
      case 4:
        this.#key({
          down: message[1] !== 0,
          keysym: message.readUInt32BE(4),
          keycode: 0,
        });
        return;
      case 5:
        this.#pointerEvent(
          message[1] as number,
          message.readUInt16BE(2),
          message.readUInt16BE(4),
        );
        return;
      case 6:
        this.#cutText(message);
        return;
      case 251:
        if (this.#encodings.has(EXTENDED_DESKTOP_SIZE)) {
          // The desktop's resolution belongs to its user, not the viewer.
          this.#pendingExtendedSize = { reason: 1, status: 1 };
          this.update();
        }
        return;
      case 255:
        this.#key({
          down: message.readUInt16BE(2) !== 0,
          keysym: message.readUInt32BE(4),
          keycode: message.readUInt32BE(8),
        });
        return;
      default:
        // EnableContinuousUpdates and fences are never offered.
        return;
    }
  }

  #setEncodings(message: Buffer): void {
    const count = message.readUInt16BE(2);
    const encodings = new Set<number>();
    let jpegLevel: number | undefined;
    let zlibLevel: number | undefined;
    for (let i = 0; i < count; i++) {
      const encoding = message.readInt32BE(4 + i * 4);
      encodings.add(encoding);
      if (
        jpegLevel === undefined &&
        encoding >= QUALITY_LEVEL_0 &&
        encoding <= QUALITY_LEVEL_0 + 9
      )
        jpegLevel = encoding - QUALITY_LEVEL_0;
      if (
        zlibLevel === undefined &&
        encoding >= COMPRESS_LEVEL_0 &&
        encoding <= COMPRESS_LEVEL_0 + 9
      )
        zlibLevel = encoding - COMPRESS_LEVEL_0;
    }
    this.#encodings = encodings;
    this.#jpegLevel = jpegLevel;
    this.#zlibLevel = Math.max(1, zlibLevel ?? DEFAULT_ZLIB_LEVEL);
    this.#negotiated = true;
    if (encodings.has(EXTENDED_DESKTOP_SIZE) && !this.#announcedExtendedSize) {
      this.#announcedExtendedSize = true;
      this.#pendingExtendedSize ??= { reason: 0, status: 0 };
    }
    if (this.#resizedEarly) {
      this.#resizedEarly = false;
      this.#followResize();
      if (this.#phase === 'closed') return;
    }
    if (encodings.has(QEMU_EXTENDED_KEY) && !this.#announcedQemu) {
      this.#announcedQemu = true;
      this.#pendingQemu = true;
    }
    if (encodings.has(EXTENDED_CLIPBOARD) && !this.#sentClipboardCaps) {
      this.#sentClipboardCaps = true;
      this.#write(clipboardCaps());
    }
    this.#host.qualityChanged();
    this.update();
  }

  #updateRequest(message: Buffer): void {
    const framebuffer = this.#host.framebuffer();
    if (!framebuffer) return;
    const incremental = message[1] !== 0;
    const rect = {
      x: message.readUInt16BE(2),
      y: message.readUInt16BE(4),
      width: message.readUInt16BE(6),
      height: message.readUInt16BE(8),
    };
    if (!incremental) {
      framebuffer.tiles.forEach((tile, index) => {
        if (intersects(tile.rect, rect)) this.#sent[index] = 0;
      });
    }
    this.#request = { incremental, rect };
    this.update();
  }

  #encode(framebuffer: Framebuffer, tile: Tile): Buffer {
    const jpeg = tile.jpeg;
    const tight = this.#tightAllowed();
    const key = jpeg
      ? 'jpeg'
      : tight
        ? `tight:${this.#zlibLevel}`
        : `raw:${pixelFormatKey(this.#format)}`;
    let encoded = tile.encoded.get(key);
    if (!encoded) {
      if (jpeg) {
        encoded = Buffer.concat([
          rectHeader(tile.rect, ENCODING_TIGHT),
          encodeTightJpeg(jpeg),
        ]);
      } else if (tight) {
        encoded = Buffer.concat([
          rectHeader(tile.rect, ENCODING_TIGHT),
          encodeTight(
            framebuffer.pixels(tile),
            tile.rect.width,
            tile.rect.height,
            this.#zlibLevel,
          ),
        ]);
      } else {
        encoded = Buffer.concat([
          rectHeader(tile.rect, ENCODING_RAW),
          encodeRaw(framebuffer.pixels(tile), this.#format),
        ]);
      }
      tile.encoded.set(key, encoded);
    }
    return encoded;
  }

  #tightAllowed(): boolean {
    return this.#encodings.has(ENCODING_TIGHT) && tightCompatible(this.#format);
  }

  #jpegAllowed(): boolean {
    return this.#tightAllowed() && this.#jpegLevel !== undefined;
  }

  #cutText(message: Buffer): void {
    const length = message.readInt32BE(4);
    const payload = message.subarray(8);
    if (length >= 0) {
      const text = decodeLegacyCutText(payload);
      this.#input(() => this.#host.setClipboard(text));
      return;
    }
    const clipboard = parseClipboardMessage(payload);
    switch (clipboard.action) {
      case 'request': {
        const text = this.#host.clipboardText();
        if (clipboard.formats & CLIPBOARD_TEXT && text !== undefined)
          this.#write(clipboardProvide(text));
        return;
      }
      case 'peek':
        this.#write(clipboardNotify(this.#host.clipboardText() !== undefined));
        return;
      case 'notify':
        if (clipboard.formats & CLIPBOARD_TEXT) {
          this.#write(clipboardRequest());
          this.#holdInput();
        }
        return;
      case 'provide': {
        const { text } = clipboard;
        if (text !== undefined) this.#host.setClipboard(text);
        this.#releaseInput();
        return;
      }
      default:
        return;
    }
  }

  #key(key: StreamKey): void {
    this.#input(() => {
      const id = key.keycode ? `c${key.keycode}` : `s${key.keysym}`;
      if (key.down) this.#keys.set(id, key);
      else this.#keys.delete(id);
      this.#host.key(key);
    });
  }

  #pointerEvent(mask: number, x: number, y: number): void {
    this.#input(() => {
      const framebuffer = this.#host.framebuffer();
      if (!framebuffer) return;
      x = Math.min(x, framebuffer.width - 1);
      y = Math.min(y, framebuffer.height - 1);
      if (x !== this.#pointer.x || y !== this.#pointer.y) {
        this.#pointer = { x, y };
        this.#host.move(x, y);
      }
      for (const [bit, button] of BUTTONS) {
        if ((mask & bit) !== (this.#buttons & bit))
          this.#host.button(button, (mask & bit) !== 0, x, y);
      }
      for (const [bit, direction] of WHEELS) {
        if (mask & bit && !(this.#buttons & bit))
          this.#host.wheel(direction, x, y);
      }
      this.#buttons = mask;
    });
  }

  #input(action: () => void): void {
    const held = this.#held;
    if (!held) {
      action();
      return;
    }
    held.queue.push(action);
    if (held.queue.length >= MAX_HELD_INPUT) this.#releaseInput();
  }

  #holdInput(): void {
    if (this.#held) return;
    const timer = setTimeout(() => this.#releaseInput(), CLIPBOARD_WAIT_MS);
    timer.unref?.();
    this.#held = { timer, queue: [] };
  }

  #releaseInput(): void {
    const held = this.#held;
    if (!held) return;
    this.#held = undefined;
    clearTimeout(held.timer);
    for (const action of held.queue) {
      if (this.#phase === 'closed') return;
      action();
    }
  }
}

function messageLength(data: Buffer): number | undefined {
  if (data.length < 1) return undefined;
  let length: number | undefined;
  switch (data[0]) {
    case 0:
      return 20;
    case 2:
      length = data.length < 4 ? undefined : 4 + 4 * data.readUInt16BE(2);
      break;
    case 3:
      return 10;
    case 4:
      return 8;
    case 5:
      return 6;
    case 6:
      length = data.length < 8 ? undefined : 8 + Math.abs(data.readInt32BE(4));
      break;
    case 150:
      return 10;
    case 248:
      return data.length < 9 ? undefined : 9 + (data[8] as number);
    case 251:
      length = data.length < 8 ? undefined : 8 + 16 * (data[6] as number);
      break;
    case 255:
      if (data.length < 2) return undefined;
      if (data[1] === 0) return 12;
      throw new RfbProtocolError(`Unsupported QEMU client message ${data[1]}`);
    default:
      throw new RfbProtocolError(
        `Unsupported RFB client message type ${data[0]}`,
      );
  }
  if (length !== undefined && length > MAX_RFB_CLIENT_MESSAGE_BYTES)
    throw new RfbProtocolError(
      `RFB client message exceeds ${MAX_RFB_CLIENT_MESSAGE_BYTES} bytes`,
    );
  return length;
}

function intersects(a: Region, b: Region): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

function extendedDesktopSize(
  framebuffer: Framebuffer,
  { reason, status }: { reason: number; status: number },
): Buffer {
  const screen = Buffer.alloc(20);
  screen[0] = 1;
  screen.writeUInt16BE(framebuffer.width, 12);
  screen.writeUInt16BE(framebuffer.height, 14);
  return Buffer.concat([
    rectHeader(
      {
        x: reason,
        y: status,
        width: framebuffer.width,
        height: framebuffer.height,
      },
      EXTENDED_DESKTOP_SIZE,
    ),
    screen,
  ]);
}
