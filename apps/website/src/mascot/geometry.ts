import type { BodyShape } from './presets';
export function roundedPath(points: readonly (readonly [number, number])[]) {
  let path = '';
  // A periodic cubic B-spline rounds across the rig points instead of passing
  // through each one. Its curvature stays continuous, including at the sole.
  points.forEach((current, i) => {
    const previous = points[(i + points.length - 1) % points.length] ?? current;
    const next = points[(i + 1) % points.length] ?? current;
    const after = points[(i + 2) % points.length] ?? current;
    if (i === 0) {
      path = `M ${(previous[0] + 4 * current[0] + next[0]) / 6} ${(previous[1] + 4 * current[1] + next[1]) / 6}`;
    }
    path += ` C ${(2 * current[0] + next[0]) / 3} ${(2 * current[1] + next[1]) / 3}, ${(current[0] + 2 * next[0]) / 3} ${(current[1] + 2 * next[1]) / 3}, ${(current[0] + 4 * next[0] + after[0]) / 6} ${(current[1] + 4 * next[1] + after[1]) / 6}`;
  });
  return `${path} Z`;
}

export function getKlexEyeColor(bodyColor: string): string {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(bodyColor);
  if (!match) return '#172033';

  const red = Number.parseInt(match[1] ?? '7c', 16);
  const green = Number.parseInt(match[2] ?? '3a', 16);
  const blue = Number.parseInt(match[3] ?? 'ed', 16);
  const brightness = red * 0.299 + green * 0.587 + blue * 0.114;

  return brightness > 160 ? '#172033' : '#ffffff';
}

// Sample the same periodic B-spline used to draw the body.
export function bodyContour(shape: BodyShape) {
  const outline = shape.outline;
  return outline.flatMap((point, i) => {
    const previous =
      outline[(i + outline.length - 1) % outline.length] ?? point;
    const next = outline[(i + 1) % outline.length] ?? point;
    const after = outline[(i + 2) % outline.length] ?? point;
    return Array.from({ length: 8 }, (_, sample) => {
      const t = sample / 8;
      const weights = [
        (1 - t) ** 3 / 6,
        (3 * t ** 3 - 6 * t ** 2 + 4) / 6,
        (-3 * t ** 3 + 3 * t ** 2 + 3 * t + 1) / 6,
        t ** 3 / 6,
      ];
      return [0, 1].map((axis) =>
        [previous, point, next, after].reduce(
          (sum, p, index) => sum + (p[axis] ?? 0) * (weights[index] ?? 0),
          0,
        ),
      );
    });
  });
}
