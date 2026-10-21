import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

import { expect, test } from 'vitest';

import { bodyRig, klexBody } from './glide';
import { goldenCases } from './glide.fixtures';

type Golden = {
  name: string;
  points: readonly (readonly [number, number])[];
  path: string;
};
const fixture = new URL('./glide.golden.json.gz', import.meta.url);
test('preserves the original rig points and spline coordinates', () => {
  const cases = [...goldenCases()];
  const baseline: Golden[] = JSON.parse(
    gunzipSync(readFileSync(fixture)).toString(),
  );
  expect(baseline.length).toBe(cases.length);
  for (const [index, entry] of cases.entries()) {
    const saved = baseline[index]!;
    expect(entry.name).toBe(saved.name);
    const { pose, settings, shape, reaction } = entry;
    const points = bodyRig(pose, settings, shape, reaction).points;
    let error = 0;
    for (const [i, point] of points.entries()) {
      error = Math.max(
        error,
        Math.abs(point[0] - saved.points[i]![0]),
        Math.abs(point[1] - saved.points[i]![1]),
      );
    }
    expect(points.length, entry.name).toBe(saved.points.length);
    expect(error, entry.name).toBeLessThanOrEqual(1e-9);
    const numbers = (path: string) =>
      path.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/g)!.map(Number);
    const current = numbers(klexBody(pose, settings, shape, reaction));
    const original = numbers(saved.path);
    expect(current.length, entry.name).toBe(original.length);
    expect(
      Math.max(...current.map((value, i) => Math.abs(value - original[i]!))),
      entry.name,
    ).toBeLessThanOrEqual(0.005000000001);
  }
}, 30000);
