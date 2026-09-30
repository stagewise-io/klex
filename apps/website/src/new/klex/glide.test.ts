import { expect, test } from 'vitest';

import { heroLooks } from '../bot-looks';
import { klexBody } from './glide';
import type { BodyShape } from './presets';

function bounds(shape: BodyShape, facing: number) {
  const path = klexBody(
    {
      facing,
      look: facing,
      lean: 0,
      drag: 0,
      energy: 0,
      phase: 0,
      crawl: 1,
      floating: 0,
      compression: 0,
    },
    undefined,
    shape,
  );
  expect(path).not.toMatch(/NaN|Infinity/);
  const coordinates = Array.from(
    path.matchAll(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/g),
    ([value]) => Number(value),
  );
  const x = coordinates.filter((_, index) => index % 2 === 0);
  const y = coordinates.filter((_, index) => index % 2 === 1);
  return {
    width: Math.max(...x) - Math.min(...x),
    height: Math.max(...y) - Math.min(...y),
  };
}

test('hero silhouettes retain their size throughout a direction change', () => {
  for (const { shape } of Object.values(heroLooks)) {
    const resting = bounds(shape, 1);
    for (let step = 0; step <= 20; step++) {
      const turning = bounds(shape, 1 - step / 10);
      expect(turning.width).toBeGreaterThan(resting.width * 0.75);
      expect(turning.height).toBeGreaterThan(resting.height * 0.95);
    }
  }
});

test('turning does not depend on the outline starting point', () => {
  for (const { shape } of Object.values(heroLooks)) {
    const shifted = {
      ...shape,
      outline: [...shape.outline.slice(3), ...shape.outline.slice(0, 3)],
    };
    for (const facing of [-1, -0.5, 0, 0.5, 1]) {
      const original = bounds(shape, facing);
      const turning = bounds(shifted, facing);
      expect(turning.width).toBeCloseTo(original.width, 8);
      expect(turning.height).toBeCloseTo(original.height, 8);
    }
  }
});
