import { emotePose, REST_EMOTE } from './emotes';

const between = (min: number, max: number) => min + Math.random() * (max - min);

// Each mounted Klex owns its clocks. New pauses are drawn after every action,
// so a row of avatars does not repeat the same loop with a fixed offset.
export function createIdle() {
  let time = between(0, 12);
  const breathDuration = between(4.4, 5.6);
  let blinkIn = between(2.5, 6);
  let blinkTime = Infinity;
  let blinkDuration = 0.35;
  let glanceIn = between(3, 8);
  let glanceTime = Infinity;
  let glanceDuration = 2.5;
  let glanceX = 0;
  let glanceY = 0;

  return {
    advance(dt: number, resting: boolean) {
      time += dt;
      blinkTime += dt;
      glanceTime += dt;
      // Finish ongoing gestures while fading out, but start no new ones during
      // travel or emotes. Pausing the controller freezes these clocks as well.
      if (!resting) return;
      blinkIn -= dt;
      glanceIn -= dt;
      if (blinkIn <= 0) {
        blinkTime = 0;
        blinkDuration = between(0.28, 0.4);
        blinkIn = blinkDuration + between(2.5, 6.5);
      }
      if (glanceIn <= 0) {
        glanceTime = 0;
        glanceDuration = between(1.8, 3.2);
        glanceIn = glanceDuration + between(3, 9);
        const angle = between(0, Math.PI * 2);
        const distance = between(0.65, 1);
        glanceX = Math.cos(angle) * distance;
        glanceY = Math.sin(angle) * distance * 0.7;
      }
    },
    pose(weight: number) {
      const breath = (time * Math.PI * 2) / breathDuration;
      const blink = emotePose('blink', blinkTime / blinkDuration).blinkLeft;
      const glance = emotePose('look-right', glanceTime / glanceDuration).lookX;
      return {
        ...REST_EMOTE,
        compression: (1 - Math.cos(breath)) * 0.009 * weight,
        headSway: Math.sin(breath / 2) * 0.65 * weight,
        headTilt: Math.sin(breath / 2 - 0.45) * 0.75 * weight,
        nod: Math.sin(breath - 0.6) * 0.15 * weight,
        lookX: glance * glanceX * weight,
        lookY: glance * glanceY * weight,
        blinkLeft: blink * weight,
        blinkRight: blink * weight,
      };
    },
  };
}
