import { bench, describe, vi } from 'vitest';

import { roundedPath } from '../../mascot/geometry';
import { fitGaze, gazeRoom } from './gaze';
import { bodyRig, DEFAULT_GLIDE, klexBody } from './glide';
import { benchmarkFrames } from './glide.fixtures';
import { BODY_SHAPES } from './presets';

describe('Klex: 1,000 frames', () => {
  for (const activity of ['idle', 'working', 'crawl'] as const) {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const frames = benchmarkFrames(activity);
    random.mockRestore();
    const points: [number, number][] = [];
    const rigFrames = frames.map(({ pose, reaction }) => ({
      pose: { ...pose, facing: pose.facing * (1 - 2 * reaction.turn) },
      reaction: fitGaze(reaction, gazeRoom(BODY_SHAPES[0])),
    }));
    bench(`${activity} controller rig + path`, () => {
      for (const { pose, reaction } of rigFrames)
        roundedPath(
          bodyRig(pose, DEFAULT_GLIDE, BODY_SHAPES[0], reaction, points).points,
        );
    });
    bench(activity, () => {
      for (const { pose, reaction } of frames)
        klexBody(pose, undefined, undefined, reaction);
    });
  }
  const outlines = benchmarkFrames('crawl').map(
    ({ pose, reaction }) =>
      bodyRig(pose, DEFAULT_GLIDE, BODY_SHAPES[0], reaction).points,
  );
  bench('roundedPath', () => {
    for (const points of outlines) roundedPath(points);
  });
});
