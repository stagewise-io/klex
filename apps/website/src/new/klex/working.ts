import { emotePose } from './emotes';

const phases = ['reading', 'typing', 'thinking'] as const;
const between = (min: number, max: number) => min + Math.random() * (max - min);

// Each avatar chooses new phases and timings throughout its lifetime.
export function createWorking() {
  let phase = phases[Math.floor(Math.random() * phases.length)];
  const duration = () =>
    phase === 'reading'
      ? between(4, 7)
      : phase === 'typing'
        ? between(2.5, 5)
        : between(1.8, 3.5);
  let phaseDuration = duration();
  let time = between(0, phaseDuration * 0.7);
  let direction = Math.random() < 0.5 ? -1 : 1;
  let blinkIn = between(2, 5);
  let blinkTime = Infinity;
  let tapIn = 0;
  let tapTime = Infinity;
  const pose = {
    compression: 0.025,
    headTilt: 0,
    headSway: 0,
    nod: 0.15,
    lookX: 0,
    lookY: 1,
    laptopTap: 0,
    laptopFloat: 1,
  };

  return {
    get thinking() {
      return phase === 'thinking' && time > 0.25;
    },
    advance(dt: number) {
      time += dt;
      blinkTime += dt;
      blinkIn -= dt;
      tapTime += dt;
      if (time >= phaseDuration) {
        const choices = phases.filter((next) => next !== phase);
        phase = choices[Math.floor(Math.random() * choices.length)];
        phaseDuration = duration();
        time = 0;
        direction = Math.random() < 0.5 ? -1 : 1;
        blinkIn = 0;
        tapIn = 0;
        tapTime = Infinity;
      }
      if (blinkIn <= 0) {
        blinkTime = 0;
        blinkIn = between(2, 5);
      }
      if (phase === 'typing') {
        tapIn -= dt;
        if (tapIn <= 0) {
          tapTime = 0;
          tapIn =
            Math.random() < 0.22 ? between(0.35, 0.7) : between(0.1, 0.24);
        }
      }
      const tap =
        phase === 'typing' && tapTime < 0.16
          ? Math.sin((tapTime / 0.16) * Math.PI)
          : 0;
      const line = (time / phaseDuration) * 4;
      const column = Math.floor((line % 1) * 5) / 4;
      const thinking = phase === 'thinking';
      const target = {
        compression: 0.025 + tap * 0.014,
        headTilt: thinking ? direction * 4 : 0,
        headSway: thinking ? direction * 0.8 : tap * direction * 0.3,
        nod: thinking ? -0.3 : 0.15 + tap * 0.45,
        lookX: thinking
          ? direction * 3
          : phase === 'reading'
            ? 3 - column * 6
            : direction * 0.7,
        lookY: thinking
          ? -6
          : phase === 'reading'
            ? -1 + Math.floor(line) * 1.7
            : 3,
        laptopTap: tap * 0.65,
        laptopFloat: phase === 'typing' ? 0 : 1,
      };
      for (const key of Object.keys(pose) as (keyof typeof pose)[]) {
        pose[key] += (target[key] - pose[key]) * (1 - Math.exp(-18 * dt));
      }
    },
    pose() {
      const blink = emotePose('blink', blinkTime / 0.3).blinkLeft;
      return { ...pose, blinkLeft: blink, blinkRight: blink };
    },
  };
}
