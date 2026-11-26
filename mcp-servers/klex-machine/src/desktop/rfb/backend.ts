import type { Region, ScreenSize } from '../provider.js';

/**
 * Side of a square tile in framebuffer pixels. Captures send every update as
 * whole tiles on this grid (smaller at the right and bottom edges).
 */
export const STREAM_TILE_SIZE = 128;

export type StreamButton = 'left' | 'middle' | 'right';
export type StreamWheel = 'up' | 'down' | 'left' | 'right';

export interface StreamKey {
  down: boolean;
  /** X11 keysym, for keys a viewer could not map to a physical key. */
  keysym: number;
  /**
   * QEMU XT keycode of the physical key, or 0 when unknown. One-byte set 1
   * scancodes are as-is; 0xE0-prefixed ones are the second byte | 0x80.
   */
  keycode: number;
}

/**
 * Where a running capture reports what it sees. Pixels are BGRX, 4 bytes
 * each, rows packed. Tiles of one frame take effect together on `frame()`.
 */
export interface StreamSink {
  /** The framebuffer size; a full frame of tiles follows. */
  resize(size: ScreenSize): void;
  raw(tile: Region, pixels: Buffer): void;
  jpeg(tile: Region, data: Buffer): void;
  frame(): void;
  /** The desktop's clipboard changed to this text. */
  clipboard(text: string): void;
  /** The capture stopped on its own; nothing more follows. */
  ended(error?: Error): void;
}

/** One running capture, plus input and clipboard for the same desktop. */
export interface StreamCapture {
  /** JPEG quality 1 to 100 for busy tiles, or undefined for lossless only. */
  setQuality(quality: number | undefined): void;
  /** Sends every tile again. */
  refresh(): void;
  /** Coordinates are framebuffer pixels. */
  move(x: number, y: number): void;
  button(button: StreamButton, down: boolean, x: number, y: number): void;
  wheel(direction: StreamWheel, x: number, y: number): void;
  key(key: StreamKey): void;
  setClipboard(text: string): void;
  stop(): void;
}

/** A platform's frame, input and clipboard source for the RFB server. */
export interface StreamBackend {
  start(sink: StreamSink): StreamCapture;
}
