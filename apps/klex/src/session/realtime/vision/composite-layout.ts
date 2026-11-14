/** Most video tracks tiled into one composite frame. */
export const MAX_TILES = 4;
/** Long edge of every composite; provider token cost per frame is fixed. */
export const COMPOSITE_LONG_EDGE = 1024;
const GRID_TILE_WIDTH = COMPOSITE_LONG_EDGE / 2;
const GRID_TILE_HEIGHT = 288;

export type TilePosition =
  | 'full'
  | 'left'
  | 'right'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right';

export interface TileRect {
  readonly position: TilePosition;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CompositeLayout {
  readonly width: number;
  readonly height: number;
  readonly tiles: readonly TileRect[];
}

const GRID_POSITIONS: readonly TilePosition[] = [
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
];

/**
 * Lays out `count` tiles. One tile keeps the upright frame's aspect ratio,
 * fitted within the long edge without enlarging; two sit side by side; three
 * or four form a 2x2 grid of 16:9 tiles.
 */
export function compositeLayout(
  count: number,
  single?: { readonly width: number; readonly height: number },
): CompositeLayout | undefined {
  if (count <= 0 || count > MAX_TILES) return undefined;
  if (count === 1) {
    if (!single || single.width <= 0 || single.height <= 0) return undefined;
    const scale = Math.min(
      1,
      COMPOSITE_LONG_EDGE / Math.max(single.width, single.height),
    );
    const width = Math.max(1, Math.round(single.width * scale));
    const height = Math.max(1, Math.round(single.height * scale));
    return {
      width,
      height,
      tiles: [{ position: 'full', x: 0, y: 0, width, height }],
    };
  }
  if (count === 2)
    return {
      width: COMPOSITE_LONG_EDGE,
      height: GRID_TILE_HEIGHT,
      tiles: (['left', 'right'] as const).map((position, index) => ({
        position,
        x: index * GRID_TILE_WIDTH,
        y: 0,
        width: GRID_TILE_WIDTH,
        height: GRID_TILE_HEIGHT,
      })),
    };
  return {
    width: COMPOSITE_LONG_EDGE,
    height: GRID_TILE_HEIGHT * 2,
    tiles: GRID_POSITIONS.slice(0, count).map((position, index) => ({
      position,
      x: (index % 2) * GRID_TILE_WIDTH,
      y: Math.floor(index / 2) * GRID_TILE_HEIGHT,
      width: GRID_TILE_WIDTH,
      height: GRID_TILE_HEIGHT,
    })),
  };
}

/** Upright size of a frame that a viewer rotates by `rotation` degrees. */
export function uprightSize(frame: {
  readonly width: number;
  readonly height: number;
  readonly rotation: number;
}): { width: number; height: number } {
  return frame.rotation === 90 || frame.rotation === 270
    ? { width: frame.height, height: frame.width }
    : { width: frame.width, height: frame.height };
}

export function positionName(position: TilePosition): string {
  return position.replace('-', ' ');
}
