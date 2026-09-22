import type { REST_EMOTE } from './emotes';
import { bodyContour } from './geometry';
import type { BodyShape } from './presets';

// Measure once per body shape. Sampling the same periodic B-spline as the
// body keeps custom eye placement from gaining unsafe extra travel.
export function gazeRoom(shape: BodyShape) {
  const contour = bodyContour(shape);
  let clearance = Infinity;
  for (const offset of [-9, 9]) {
    const eyeX = 80 + shape.eyeX + offset;
    for (let i = 0; i < contour.length; i++) {
      const [ax = 0, ay = 0] = contour[i] ?? [];
      const [bx = ax, by = ay] = contour[(i + 1) % contour.length] ?? [];
      const dx = bx - ax;
      const dy = by - ay;
      const t = Math.max(
        0,
        Math.min(
          1,
          ((eyeX - ax) * dx + (shape.eyeY - ay) * dy) /
            (dx * dx + dy * dy || 1),
        ),
      );
      clearance = Math.min(
        clearance,
        Math.hypot(eyeX - ax - t * dx, shape.eyeY - ay - t * dy),
      );
    }
  }
  // Room for the largest eye symbol and the static expression's small offset.
  return Math.max(0, clearance - 8.5);
}

export function fitGaze(reaction: typeof REST_EMOTE, room: number) {
  const distance = Math.hypot(reaction.lookX, reaction.lookY);
  if (distance <= room || distance === 0) return reaction;
  const ratio = room / distance;
  return {
    ...reaction,
    lookX: reaction.lookX * ratio,
    lookY: reaction.lookY * ratio,
    // The head follows the remaining distance. Even a narrow drawn head can
    // make a pronounced glance without the eyes leaving its silhouette.
    gazeHeadX: reaction.lookX * (1 - ratio),
    gazeHeadY: reaction.lookY * (1 - ratio),
  };
}
