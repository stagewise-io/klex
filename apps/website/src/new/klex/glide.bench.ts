import { bench, describe, vi } from 'vitest';

import { roundedPath } from '../../mascot/geometry';
import { klexBody } from './glide';
import { benchmarkFrames } from './glide.fixtures';
import { BODY_SHAPES } from './presets';

describe('Klex: 1,000 frames', () => {
  for (const activity of ['idle', 'working', 'crawl'] as const) {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const frames = benchmarkFrames(activity);
    random.mockRestore();
    bench(activity, () => {
      for (const { pose, reaction } of frames)
        klexBody(pose, undefined, undefined, reaction);
    });
  }
  bench('roundedPath', () => {
    for (let frame = 0; frame < 1000; frame++)
      roundedPath(BODY_SHAPES[0].outline);
  });
});
