import { spring } from 'motion';

import { REST_EMOTE } from './emotes';
import { createIdle } from './idle';
import { createWorking } from './working';

export const ACTIVITIES = [
  { id: 'idle', name: 'Idle' },
  { id: 'sleeping', name: 'Sleeping' },
  { id: 'working', name: 'Working' },
] as const;
export type KlexActivity = (typeof ACTIVITIES)[number]['id'];

function activityPose(activity: KlexActivity | false, time: number) {
  const phase = (time * Math.PI * 2) / 6;
  if (activity === 'sleeping') {
    return {
      ...REST_EMOTE,
      compression: 0.1 + 0.025 * (1 - Math.cos(phase)),
      headTilt: -8 + 1.5 * Math.sin(phase),
      headSway: -3 + Math.sin(phase),
      nod: 0.65 + 0.15 * Math.sin(phase),
      blinkLeft: 1,
      blinkRight: 1,
    };
  }
  if (activity === 'working') {
    return {
      ...REST_EMOTE,
      compression: 0.025,
      nod: 0.15,
      lookY: 2,
    };
  }
  return REST_EMOTE;
}

// Blend persistent poses on the existing ticker, including interrupted changes.
export function createActivity() {
  const idle = createIdle();
  const working = createWorking();
  const weights = { idle: 0, sleeping: 0, working: 0 };
  let time = Math.random() * 6;
  let laptopScale = 0;
  let laptopVisible = false;
  let laptopSpring: ReturnType<typeof spring> | null = null;
  let laptopTime = 0;

  return {
    get active() {
      return (
        laptopSpring !== null || ACTIVITIES.some(({ id }) => weights[id] > 0)
      );
    },
    get laptopScale() {
      return laptopScale;
    },
    snapLaptop(visible: boolean) {
      laptopVisible = visible;
      laptopScale = Number(visible);
      laptopSpring = null;
    },
    get workingBob() {
      const { laptopFloat, laptopTap } = working.pose();
      return (
        (Math.sin((time * Math.PI * 2) / 3.6) * 2.5 * laptopFloat + laptopTap) *
        weights.working
      );
    },
    get thinking() {
      return working.thinking;
    },
    advance(dt: number, activity: KlexActivity | false) {
      time += dt;
      const showLaptop = activity === 'working';
      if (showLaptop) working.advance(dt);
      if (showLaptop !== laptopVisible) {
        laptopVisible = showLaptop;
        laptopTime = 0;
        laptopSpring = spring({
          keyframes: [laptopScale, Number(showLaptop)],
          bounce: showLaptop ? 0.6 : 0,
          visualDuration: showLaptop ? 0.28 : 0.12,
        });
      }
      if (laptopSpring) {
        laptopTime += dt;
        const frame = laptopSpring.next(laptopTime * 1000);
        laptopScale = frame.value;
        if (frame.done) laptopSpring = null;
      }
      idle.advance(dt, activity === 'idle');
      for (const { id } of ACTIVITIES) {
        const target = activity === id ? 1 : 0;
        const next = target + (weights[id] - target) * Math.exp(-6 * dt);
        weights[id] = Math.abs(next - target) < 0.0001 ? target : next;
      }
    },
    pose(staticActivity?: KlexActivity | false) {
      // Reduced motion keeps a recognizable pose without a running clock.
      if (staticActivity !== undefined)
        return activityPose(staticActivity, 1.5);
      const resting = idle.pose(weights.idle);
      const sleeping = activityPose('sleeping', time);
      const workingPose = working.pose();
      const pose = { ...REST_EMOTE };
      for (const key of [
        'compression',
        'headTilt',
        'headSway',
        'nod',
        'lookX',
        'lookY',
        'blinkLeft',
        'blinkRight',
      ] as const) {
        pose[key] =
          resting[key] +
          sleeping[key] * weights.sleeping +
          workingPose[key] * weights.working;
      }
      return pose;
    },
  };
}
