import type { Region, ScreenSize } from '../provider.js';
import { STREAM_TILE_SIZE } from './backend.js';

export interface Tile {
  rect: Region;
  /** Bumped on every change; 0 until the tile first arrives. */
  version: number;
  /** The tile's current content when a capture sent it as JPEG. */
  jpeg: Buffer | undefined;
  /** Encoded rects for the current version, keyed by encoding and format. */
  encoded: Map<string, Buffer>;
}

type Staged =
  | { index: number; pixels: Buffer }
  | { index: number; jpeg: Buffer };

/**
 * The latest content of the desktop as a grid of tiles. Lossless tiles keep
 * their BGRX pixels; JPEG tiles keep the JPEG, since every viewer that can be
 * sent one decodes it. Tiles of a frame are staged and applied together.
 */
export class Framebuffer {
  readonly width: number;
  readonly height: number;
  readonly tiles: Tile[];
  readonly #columns: number;
  readonly #pixels: Buffer;
  #staged: Staged[] = [];
  #version = 0;

  constructor(
    size: ScreenSize,
    readonly tileSize = STREAM_TILE_SIZE,
  ) {
    this.width = size.width;
    this.height = size.height;
    this.#columns = Math.ceil(size.width / tileSize);
    const rows = Math.ceil(size.height / tileSize);
    this.#pixels = Buffer.alloc(size.width * size.height * 4);
    this.tiles = [];
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < this.#columns; column++) {
        const x = column * tileSize;
        const y = row * tileSize;
        this.tiles.push({
          rect: {
            x,
            y,
            width: Math.min(tileSize, size.width - x),
            height: Math.min(tileSize, size.height - y),
          },
          version: 0,
          jpeg: undefined,
          encoded: new Map(),
        });
      }
    }
  }

  /** Stages lossless BGRX pixels for one tile; false when they do not fit. */
  stageRaw(rect: Region, pixels: Buffer): boolean {
    const index = this.#index(rect);
    if (index === undefined || pixels.length !== rect.width * rect.height * 4)
      return false;
    this.#staged.push({ index, pixels });
    return true;
  }

  stageJpeg(rect: Region, jpeg: Buffer): boolean {
    const index = this.#index(rect);
    if (index === undefined || jpeg.length === 0) return false;
    this.#staged.push({ index, jpeg });
    return true;
  }

  /** Applies the staged tiles; true when any changed. */
  commit(): boolean {
    const staged = this.#staged;
    this.#staged = [];
    for (const update of staged) {
      const tile = this.tiles[update.index] as Tile;
      tile.version = ++this.#version;
      tile.encoded.clear();
      if ('jpeg' in update) {
        tile.jpeg = update.jpeg;
        continue;
      }
      tile.jpeg = undefined;
      const { x, y, width, height } = tile.rect;
      const stride = this.width * 4;
      for (let row = 0; row < height; row++) {
        update.pixels.copy(
          this.#pixels,
          (y + row) * stride + x * 4,
          row * width * 4,
          (row + 1) * width * 4,
        );
      }
    }
    return staged.length > 0;
  }

  /** The tile's BGRX pixels; meaningless for a JPEG tile. */
  pixels(tile: Tile): Buffer {
    const { x, y, width, height } = tile.rect;
    const out = Buffer.alloc(width * height * 4);
    const stride = this.width * 4;
    for (let row = 0; row < height; row++) {
      this.#pixels.copy(
        out,
        row * width * 4,
        (y + row) * stride + x * 4,
        (y + row) * stride + (x + width) * 4,
      );
    }
    return out;
  }

  #index(rect: Region): number | undefined {
    const { tileSize } = this;
    if (rect.x % tileSize !== 0 || rect.y % tileSize !== 0) return undefined;
    const index = (rect.y / tileSize) * this.#columns + rect.x / tileSize;
    const tile = this.tiles[index];
    if (
      !tile ||
      tile.rect.x !== rect.x ||
      tile.rect.y !== rect.y ||
      tile.rect.width !== rect.width ||
      tile.rect.height !== rect.height
    )
      return undefined;
    return index;
  }
}
