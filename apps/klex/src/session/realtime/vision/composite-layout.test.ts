import { describe, expect, it } from 'vitest';

import { compositeLayout, uprightSize } from './composite-layout';

describe('compositeLayout', () => {
  it('keeps one tile at its upright size, fitted to 1024 px without enlarging', () => {
    expect(compositeLayout(1, { width: 2048, height: 1152 })).toEqual({
      width: 1024,
      height: 576,
      tiles: [{ position: 'full', x: 0, y: 0, width: 1024, height: 576 }],
    });
    expect(compositeLayout(1, { width: 320, height: 180 })?.tiles[0]).toEqual({
      position: 'full',
      x: 0,
      y: 0,
      width: 320,
      height: 180,
    });
    expect(compositeLayout(1)).toBeUndefined();
  });

  it('places two tiles side by side', () => {
    expect(compositeLayout(2)).toEqual({
      width: 1024,
      height: 288,
      tiles: [
        { position: 'left', x: 0, y: 0, width: 512, height: 288 },
        { position: 'right', x: 512, y: 0, width: 512, height: 288 },
      ],
    });
  });

  it('places three or four tiles in a 2x2 grid', () => {
    const grid = compositeLayout(4);
    expect([grid?.width, grid?.height]).toEqual([1024, 576]);
    expect(grid?.tiles.map(({ position, x, y }) => [position, x, y])).toEqual([
      ['top-left', 0, 0],
      ['top-right', 512, 0],
      ['bottom-left', 0, 288],
      ['bottom-right', 512, 288],
    ]);
    expect(compositeLayout(3)?.tiles.map(({ position }) => position)).toEqual([
      'top-left',
      'top-right',
      'bottom-left',
    ]);
    expect(compositeLayout(0)).toBeUndefined();
    expect(compositeLayout(5)).toBeUndefined();
  });

  it('swaps dimensions for quarter-turn rotations', () => {
    expect(uprightSize({ width: 640, height: 360, rotation: 90 })).toEqual({
      width: 360,
      height: 640,
    });
    expect(uprightSize({ width: 640, height: 360, rotation: 180 })).toEqual({
      width: 640,
      height: 360,
    });
  });
});
