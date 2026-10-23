import type { BodyShape } from './presets';

function fixed2(value: number) {
  // Neutral rig transforms can introduce roundoff at half-cent boundaries.
  const rounded = Math.round(
    (value + 8 * Number.EPSILON * Math.abs(value)) * 100,
  );
  const absolute = Math.abs(rounded);
  const integer = Math.floor(absolute / 100);
  const fraction = absolute - integer * 100;
  const digits =
    fraction === 0
      ? String(integer)
      : fraction % 10 === 0
        ? `${integer}.${fraction / 10}`
        : `${integer}${fraction < 10 ? '.0' : '.'}${fraction}`;
  return rounded < 0 ? `-${digits}` : digits;
}

export function roundedPath(points: readonly (readonly [number, number])[]) {
  let path = '';
  // A periodic cubic B-spline rounds across the rig points instead of passing
  // through each one. Its curvature stays continuous, including at the sole.
  for (let i = 0; i < points.length; i++) {
    const current = points[i];
    if (!current) continue;
    const previous = points[(i + points.length - 1) % points.length] ?? current;
    const next = points[(i + 1) % points.length] ?? current;
    const after = points[(i + 2) % points.length] ?? current;
    if (i === 0) {
      path = `M${fixed2((previous[0] + 4 * current[0] + next[0]) / 6)} ${fixed2((previous[1] + 4 * current[1] + next[1]) / 6)}`;
    }
    path += `C${fixed2((2 * current[0] + next[0]) / 3)} ${fixed2((2 * current[1] + next[1]) / 3)} ${fixed2((current[0] + 2 * next[0]) / 3)} ${fixed2((current[1] + 2 * next[1]) / 3)} ${fixed2((current[0] + 4 * next[0] + after[0]) / 6)} ${fixed2((current[1] + 4 * next[1] + after[1]) / 6)}`;
  }
  return `${path}Z`;
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
