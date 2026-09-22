// Focused subset of the cloud renderer's time-based poses.
export const REST_EMOTE = {
  compression: 0,
  headSway: 0,
  headTilt: 0,
  nod: 0,
  lookX: 0,
  lookY: 0,
  gazeHeadX: 0,
  gazeHeadY: 0,
  blinkLeft: 0,
  blinkRight: 0,
};
const smooth = (value: number) => {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
};
const pulse = (t: number, attack: number, release: number) =>
  smooth(t / attack) * (1 - smooth((t - release) / (1 - release)));

export function emotePose(kind: 'blink' | 'look-right' | 'hello', t: number) {
  if (t < 0 || t >= 1) return { ...REST_EMOTE };
  if (kind === 'blink') {
    const blink = pulse(t, 0.38, 0.55);
    return { ...REST_EMOTE, blinkLeft: blink, blinkRight: blink };
  }
  if (kind === 'look-right')
    return { ...REST_EMOTE, lookX: 7 * pulse(t, 0.18, 0.76) };
  return {
    ...REST_EMOTE,
    nod: Math.sin(Math.PI * t) ** 2 * Math.sin(t * Math.PI * 4),
  };
}
