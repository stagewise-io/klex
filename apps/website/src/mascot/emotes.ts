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

export type Emote =
  | 'blink'
  | 'look-right'
  | 'hello'
  | 'glance'
  | 'typing'
  | 'wink'
  | 'look-left'
  | 'look-up'
  | 'look-down'
  | 'nod'
  | 'headshake'
  | 'wiggle';

export function emotePose(kind: Emote, t: number) {
  if (!Number.isFinite(t) || t < 0 || t >= 1) return { ...REST_EMOTE };
  if (kind === 'wink')
    return { ...REST_EMOTE, blinkLeft: pulse(t, 0.38, 0.55) };
  if (kind === 'look-left' || kind === 'look-up' || kind === 'look-down') {
    const weight = pulse(t, 0.18, 0.76);
    return {
      ...REST_EMOTE,
      lookX: kind === 'look-left' ? -7 * weight : 0,
      lookY:
        kind === 'look-up'
          ? -6 * weight
          : kind === 'look-down'
            ? 6 * weight
            : 0,
    };
  }
  if (kind === 'blink') {
    const blink = pulse(t, 0.38, 0.55);
    return { ...REST_EMOTE, blinkLeft: blink, blinkRight: blink };
  }
  if (kind === 'look-right')
    return { ...REST_EMOTE, lookX: 7 * pulse(t, 0.18, 0.76) };
  const envelope = Math.sin(Math.PI * t) ** 2;
  if (kind === 'glance')
    return {
      ...REST_EMOTE,
      lookX: -6 * envelope,
      headTilt: -5 * envelope,
      blinkLeft: 0.65 * pulse(t, 0.4, 0.55),
    };
  if (kind === 'typing')
    return {
      ...REST_EMOTE,
      lookY: 3 * envelope,
      nod: Math.sin(t * Math.PI * 8) * envelope * 0.45,
      headSway: Math.sin(t * Math.PI * 6) * envelope * 1.2,
    };
  if (kind === 'wiggle' || kind === 'headshake')
    return {
      ...REST_EMOTE,
      headTilt: Math.sin(t * Math.PI * 4) * envelope * 6,
    };
  return {
    ...REST_EMOTE,
    nod: Math.sin(Math.PI * t) ** 2 * Math.sin(t * Math.PI * 4),
  };
}
