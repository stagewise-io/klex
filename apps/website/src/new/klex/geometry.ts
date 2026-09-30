import type { BodyShape } from './presets';

const mirroredOutlines = new WeakMap<BodyShape, BodyShape['outline']>();

// Align the mirrored contour before interpolating a turn. Custom outlines can
// start anywhere, so reversing their indices alone pairs unrelated body parts.
export function mirroredOutline(shape: BodyShape) {
  const cached = mirroredOutlines.get(shape);
  if (cached) return cached;
  const { outline } = shape;
  const count = outline.length;
  let bestOffset = 0;
  let bestDistance = Infinity;
  for (let offset = 0; offset < count; offset++) {
    const distance = outline.reduce((sum, [x, y], index) => {
      const [mirrorX, mirrorY] = outline[(offset - index + count) % count] ?? [
        x,
        y,
      ];
      return sum + (x - (160 - mirrorX)) ** 2 + (y - mirrorY) ** 2;
    }, 0);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestOffset = offset;
    }
  }
  const mirrored = outline.map((point, index) => {
    const [x, y] = outline[(bestOffset - index + count) % count] ?? point;
    return [160 - x, y] as const;
  });
  mirroredOutlines.set(shape, mirrored);
  return mirrored;
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

// Place the hand just outside the right edge, halfway down the body.
export function waveAnchor(shape: BodyShape) {
  const contour = bodyContour(shape);
  const heights = contour.map((point) => point[1] ?? 0);
  const y = (Math.min(...heights) + Math.max(...heights)) / 2;
  let right = -Infinity;
  for (let i = 0; i < contour.length; i++) {
    const [ax = 0, ay = 0] = contour[i] ?? [];
    const [bx = ax, by = ay] = contour[(i + 1) % contour.length] ?? [];
    if (ay > y !== by > y) {
      right = Math.max(right, ax + ((y - ay) / (by - ay)) * (bx - ax));
    }
  }
  // Extras share the face coordinate system; the emoji sits above its baseline.
  return { x: right + 10 - (80 + shape.eyeX), y: y + 6 - shape.eyeY };
}
