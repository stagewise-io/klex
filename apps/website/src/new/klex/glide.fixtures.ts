import { createActivity } from './activity';
import { EMOTES, emotePose, REST_EMOTE } from './emotes';
import { BODY_SHAPES, DEFAULT_GLIDE, MOVEMENT_STYLES } from './presets';

export const poses = {
  idle: {
    facing: 1,
    look: 1,
    lean: 0,
    drag: 0,
    energy: 0,
    phase: 0,
    crawl: 1,
    floating: 0,
    compression: 0.015,
  },
  working: {
    facing: 1,
    look: 1,
    lean: 0,
    drag: 0,
    energy: 0,
    phase: 0.7,
    crawl: 1,
    floating: 0,
    compression: -0.01,
  },
  crawl: {
    facing: 1,
    look: 1,
    lean: 0.65,
    drag: 0.4,
    energy: 0.8,
    phase: 4.2,
    crawl: 1,
    floating: 0,
    compression: 0.08,
  },
};

export function* goldenCases() {
  for (const shape of BODY_SHAPES) {
    for (const facing of [-1, -0.35, 0, 1]) {
      for (const action of EMOTES) {
        for (const time of [0, 0.25, 0.5, 0.75]) {
          yield {
            name: `${shape.id}/${facing}/${action.id}/${time}`,
            shape,
            pose: { ...poses.crawl, facing },
            settings: DEFAULT_GLIDE,
            reaction: emotePose(action.id, time),
          };
        }
      }
      for (const movement of MOVEMENT_STYLES) {
        for (const [name, base] of Object.entries(poses)) {
          yield {
            name: `${shape.id}/${facing}/${movement.id}/${name}`,
            shape,
            pose: { ...base, facing, floating: Number(movement.id === 'fly') },
            settings: movement.settings,
            reaction: REST_EMOTE,
          };
        }
      }
    }
  }
}

export function benchmarkFrames(activity: 'idle' | 'working' | 'crawl') {
  const motion = createActivity();
  return Array.from({ length: 1000 }, (_, frame) => {
    motion.advance(1 / 60, activity === 'crawl' ? false : activity);
    return {
      pose: { ...poses[activity], phase: frame / 60 },
      reaction: { ...REST_EMOTE, ...motion.pose() },
    };
  });
}
