import { REST_EMOTE } from './emotes';
import { fitGaze, gazeRoom } from './gaze';
import { roundedPath } from './geometry';
import { BODY_SHAPES, type BodyShape } from './presets';

const shape = BODY_SHAPES[0];
const rooms = new WeakMap<BodyShape, number>();

// Cloud head rig, reduced to grounded idle and nod gestures. The sole stays
// fixed while head rotation fades through the belly; eyes share the same rig.
export function rig(raw = REST_EMOTE, body: BodyShape = shape) {
  const shape = body;
  const room = rooms.get(shape) ?? gazeRoom(shape);
  rooms.set(shape, room);
  const pose = fitGaze(raw, room);
  const angle = pose.nod * 0.14 + (pose.headTilt * Math.PI) / 180;
  const pivotX = 80 + shape.eyeX - 8;
  const pivotY = shape.eyeY + 39;
  function point(
    x: number,
    y: number,
    weight: number,
  ): readonly [number, number] {
    const rotation = angle * weight;
    const dx = x - pivotX;
    const dy = y - pivotY;
    const hx =
      pivotX +
      dx * Math.cos(rotation) -
      dy * Math.sin(rotation) +
      (pose.headSway + pose.gazeHeadX) * weight ** 2;
    const hy =
      pivotY +
      dx * Math.sin(rotation) +
      dy * Math.cos(rotation) +
      pose.nod * 2 * weight +
      pose.gazeHeadY * weight ** 2;
    return [
      80 + (hx - 80) * (1 + pose.compression * 0.5),
      128 + (hy - 128) * (1 - pose.compression),
    ];
  }
  const points = shape.outline.map(([x, y]) => {
    const belly = Math.max(
      0,
      Math.min(1, (y - shape.eyeY - 7) / (128 - shape.eyeY - 7)),
    );
    return point(x, y, 1 - belly);
  });
  const [x, y] = point(80 + shape.eyeX, shape.eyeY, 1);
  return {
    path: roundedPath(points),
    face: `translate(${x} ${y}) rotate(${(angle * 180) / Math.PI})`,
    pose,
  };
}
