import { REST_EMOTE } from './emotes';

export type Activity = 'idle' | 'sleeping' | 'working' | 'note-taking';

export const activityProps = {
  working: 'laptop',
  'note-taking': 'note',
} as const;

// Cloud's reading/typing/thinking phases, driven by the mascot's existing clock.
// A local seed keeps siblings independent and makes playback reproducible.
export function createActivity(seed: number) {
  let randomState = seed >>> 0;
  const random = () => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState / 4294967296;
  };
  let phase = Math.floor(random() * 3);
  let remaining = 2 + random() * 3;
  let time = 0;
  let phaseTime = 0;
  let tapIn = 0;
  let tapTime = 1;
  let direction = 1;
  const current = { ...REST_EMOTE };
  let bob = 0;
  let writing = 0;
  return {
    advance(dt: number, activity: Activity) {
      time += dt;
      if (activity !== 'working' && activity !== 'note-taking') return;
      remaining -= dt;
      phaseTime += dt;
      tapTime += dt;
      tapIn -= dt;
      if (remaining <= 0) {
        phase = (phase + 1 + Math.floor(random() * 2)) % 3;
        remaining = phase === 0 ? 4 + random() * 3 : 2 + random() * 3;
        phaseTime = 0;
        direction = random() < 0.5 ? -1 : 1;
      }
      if (phase === 1 && tapIn <= 0) {
        tapTime = 0;
        tapIn =
          random() < 0.22 ? 0.35 + random() * 0.35 : 0.1 + random() * 0.14;
      }
      const tap =
        phase === 1 && tapTime < 0.16
          ? Math.sin((tapTime / 0.16) * Math.PI)
          : 0;
      writing += (tap - writing) * (1 - Math.exp(-24 * dt));
      const target = {
        ...REST_EMOTE,
        compression: 0.025 + tap * 0.014,
        headTilt: phase === 2 ? direction * 4 : 0,
        nod: phase === 2 ? -0.3 : 0.15 + tap * 0.45,
        lookX:
          phase === 0
            ? 3 - Math.floor(((phaseTime % 1.4) / 1.4) * 5) * 1.5
            : direction * 3,
        lookY: phase === 2 ? -6 : 2 + tap,
      };
      for (const key of Object.keys(current) as (keyof typeof current)[]) {
        current[key] += (target[key] - current[key]) * (1 - Math.exp(-18 * dt));
      }
      bob +=
        ((phase === 1
          ? tap * 0.65
          : Math.sin((time * Math.PI * 2) / 3.6) * 2.5) -
          bob) *
        (1 - Math.exp(-12 * dt));
    },
    pose(activity: Activity, reduced = false) {
      if (activity === 'sleeping')
        return {
          ...REST_EMOTE,
          compression: 0.1 + (reduced ? 0 : 0.025 * (1 - Math.cos(time))),
          headTilt: -8,
          headSway: -3,
          nod: 0.65,
          blinkLeft: 1,
          blinkRight: 1,
        };
      if (activity === 'working' || activity === 'note-taking')
        return reduced
          ? { ...REST_EMOTE, compression: 0.025, nod: 0.15, lookY: 2 }
          : { ...current };
      return { ...REST_EMOTE };
    },
    get bob() {
      return bob;
    },
    get writing() {
      return writing;
    },
  };
}
