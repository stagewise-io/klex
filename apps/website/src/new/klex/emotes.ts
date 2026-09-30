import type { Extra } from './extras';
import type { Expression } from './eyes';

const LAND_RECOVERY_START = 0.3;

const BODY_ACTIONS = [
  { id: 'jump', name: 'Jump', duration: 1.05 },
  { id: 'shiver', name: 'Shiver', duration: 0.85 },
  { id: 'nod', name: 'Nod', duration: 0.9 },
  { id: 'squish', name: 'Squish', duration: 0.9 },
  { id: 'celebrate', name: 'Celebrate', duration: 2.5 },
  { id: 'startle', name: 'Startle', duration: 1.4 },
  { id: 'headshake', name: 'Shake head', duration: 1.15 },
  { id: 'bow', name: 'Bow', duration: 1.6 },
  { id: 'recoil', name: 'Recoil', duration: 1.35 },
  { id: 'puff', name: 'Puff up', duration: 1.5 },
  { id: 'slump', name: 'Slump', duration: 1.8 },
  { id: 'melt', name: 'Melt', duration: 2.5 },
  { id: 'pop', name: 'Pop', duration: 1.25 },
  { id: 'jelly', name: 'Jiggle', duration: 1.9 },
  { id: 'fall', name: 'Fall over', duration: 2.7 },
  { id: 'recover', name: 'Get back up', duration: 2.6 },
  { id: 'land', name: 'Land and get up', duration: 2.5 },
  { id: 'dance', name: 'Dance', duration: 2.4 },
  { id: 'spin', name: 'Spin', duration: 1.6 },
  { id: 'peek', name: 'Peek forward', duration: 1.8 },
  { id: 'hide', name: 'Hide', duration: 1.9 },
  { id: 'impatient', name: 'Rock impatiently', duration: 2 },
  { id: 'sulk', name: 'Turn away', duration: 1.9 },
] as const;
const EYE_ACTIONS = [
  { id: 'blink', name: 'Blink', duration: 0.35 },
  { id: 'slow-blink', name: 'Slow blink', duration: 1.5 },
  { id: 'wink', name: 'Wink', duration: 0.85 },
  { id: 'eye-roll', name: 'Roll eyes', duration: 2.1 },
  { id: 'glance', name: 'Look around', duration: 2.8 },
  { id: 'look-left', name: 'Look left', duration: 1.7 },
  { id: 'look-right', name: 'Look right', duration: 1.7 },
  { id: 'look-up', name: 'Look up', duration: 1.7 },
  { id: 'look-down', name: 'Look down', duration: 1.7 },
] as const;
type Gesture = (typeof BODY_ACTIONS | typeof EYE_ACTIONS)[number]['id'];
export type EmoteLook = { expression?: Expression; extra?: Extra };
type ReactionStep = EmoteLook & { gesture: Gesture; duration: number };
const REACTIONS = [
  {
    id: 'happy-nod',
    name: 'Happy nod',
    steps: [{ gesture: 'nod', duration: 0.9, expression: 'happy' }],
  },
  {
    id: 'hello',
    name: 'Hello!',
    steps: [
      { gesture: 'nod', duration: 2.2, expression: 'happy', extra: 'wave' },
    ],
  },
  {
    id: 'huh',
    name: 'Huh?',
    steps: [
      {
        gesture: 'peek',
        duration: 1.8,
        expression: 'unsure',
        extra: 'question',
      },
    ],
  },
  {
    id: 'okay',
    name: 'Okay …',
    steps: [{ gesture: 'nod', duration: 1.6, expression: 'skeptical' }],
  },
  {
    id: 'nope',
    name: 'Nope.',
    steps: [
      { gesture: 'headshake', duration: 1, expression: 'annoyed' },
      { gesture: 'sulk', duration: 1.3, expression: 'annoyed' },
    ],
  },
  {
    id: 'oops',
    name: 'Oops.',
    steps: [
      {
        gesture: 'recoil',
        duration: 0.65,
        expression: 'surprised',
        extra: 'sweat',
      },
      {
        gesture: 'slump',
        duration: 1.3,
        expression: 'embarrassed',
        extra: 'sweat',
      },
    ],
  },
  {
    id: 'thanks',
    name: 'Thanks!',
    steps: [
      { gesture: 'bow', duration: 1.7, expression: 'happy', extra: 'blush' },
    ],
  },
  {
    id: 'innocent',
    name: "It wasn't me.",
    steps: [
      {
        gesture: 'glance',
        duration: 1.8,
        expression: 'surprised',
        extra: 'sweat',
      },
    ],
  },
  {
    id: 'finally',
    name: 'Finally!',
    steps: [
      { gesture: 'slump', duration: 1.1, expression: 'sleepy' },
      {
        gesture: 'celebrate',
        duration: 2.3,
        expression: 'happy',
        extra: 'sparkles',
      },
    ],
  },
  {
    id: 'exhausted',
    name: "I'm exhausted.",
    steps: [{ gesture: 'melt', duration: 2.6, expression: 'x-eyes' }],
  },
  {
    id: 'leave-me',
    name: 'Leave me alone.',
    steps: [
      { gesture: 'hide', duration: 2.1, expression: 'annoyed', extra: 'steam' },
    ],
  },
  {
    id: 'look',
    name: 'Look!',
    steps: [
      { gesture: 'puff', duration: 0.8, expression: 'stars' },
      {
        gesture: 'jump',
        duration: 1.05,
        expression: 'stars',
        extra: 'sparkles',
      },
    ],
  },
] as const satisfies readonly {
  id: string;
  name: string;
  steps: readonly ReactionStep[];
}[];

export const EMOTE_CATEGORIES = [
  { id: 'body', name: 'Body' },
  { id: 'eyes', name: 'Eyes' },
  { id: 'reactions', name: 'Reactions' },
] as const;
export const EMOTES = [
  ...BODY_ACTIONS.map((action) => ({ ...action, category: 'body' as const })),
  ...EYE_ACTIONS.map((action) => ({ ...action, category: 'eyes' as const })),
  ...REACTIONS.map((action) => ({
    ...action,
    category: 'reactions' as const,
    duration: action.steps.reduce((sum, step) => sum + step.duration, 0),
  })),
];
export type Emote = (typeof EMOTES)[number];
export const REST_EMOTE = {
  lift: 0,
  shake: 0,
  compression: 0,
  nod: 0,
  headSway: 0,
  headTilt: 0,
  turn: 0,
  hideEyes: 0,
  melt: 0,
  puff: 0,
  wave: 0,
  ripple: 0,
  ripplePhase: 0,
  roll: 0,
  impact: 0,
  lookX: 0,
  lookY: 0,
  gazeHeadX: 0,
  gazeHeadY: 0,
  blinkLeft: 0,
  blinkRight: 0,
};
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const smooth = (value: number) => {
  const t = clamp(value);
  return t * t * (3 - 2 * t);
};
const pulse = (t: number, attack = 0.3, release = 0.7) =>
  smooth(t / attack) * (1 - smooth((t - release) / (1 - release)));

// The easing belongs to the arriving key. Sharp reactions accelerate into
// an impact; slower holds and returns make the action readable afterwards.
function track(
  t: number,
  keys: readonly (readonly [number, number, ('in' | 'out')?])[],
) {
  let previous = keys[0] ?? [0, 0];
  for (const next of keys.slice(1)) {
    if (t <= next[0]) {
      const u = clamp((t - previous[0]) / (next[0] - previous[0]));
      const ease =
        next[2] === 'in'
          ? u ** 3
          : next[2] === 'out'
            ? 1 - (1 - u) ** 3
            : smooth(u);
      return previous[1] + (next[1] - previous[1]) * ease;
    }
    previous = next;
  }
  return previous[1];
}

// Time-based, reusable gestures. The rig anchors their deformation at the sole.
function gesturePose(kind: Gesture, t: number): typeof REST_EMOTE {
  if (t < 0 || t >= 1 || (t === 0 && kind !== 'land')) return REST_EMOTE;
  const e = Math.sin(Math.PI * t) ** 2;
  const wave = Math.sin(t * Math.PI * 4);
  switch (kind) {
    case 'jump': {
      const air = clamp((t - 0.2) / 0.56);
      return {
        ...REST_EMOTE,
        lift: 4 * 56 * air * (1 - air),
        compression:
          t < 0.2
            ? 0.22 * Math.sin((Math.PI * t) / 0.2)
            : t < 0.76
              ? -0.09 * Math.sin(Math.PI * air)
              : 0.18 * Math.sin((Math.PI * (t - 0.76)) / 0.24),
      };
    }
    case 'celebrate': {
      const hop = gesturePose('jump', (t * 3) % 1);
      return { ...hop, lift: hop.lift * (t < 2 / 3 ? 0.5 : 1.15) };
    }
    case 'startle': {
      const landing = pulse(clamp((t - 0.3) / 0.25), 0.18, 0.25);
      return {
        ...REST_EMOTE,
        // A reflex, not another voluntary jump with a long wind-up.
        lift: track(t, [
          [0, 0],
          [0.07, 5, 'in'],
          [0.18, 34, 'out'],
          [0.32, 0, 'in'],
          [1, 0],
        ]),
        compression: track(t, [
          [0, 0],
          [0.07, -0.17, 'out'],
          [0.27, -0.17],
          [0.34, 0.22, 'out'],
          [0.46, -0.04],
          [0.62, 0],
          [1, 0],
        ]),
        headSway: -9 * pulse(t, 0.055, 0.58),
        headTilt: -9 * pulse(t, 0.06, 0.58),
        shake:
          -3 * pulse(t, 0.12, 0.6) + 2 * landing * Math.sin(t * Math.PI * 30),
        lookY: -1.5 * pulse(t, 0.08, 0.65),
      };
    }
    case 'shiver':
      return { ...REST_EMOTE, shake: 3.5 * e * Math.sin(t * Math.PI * 18) };
    case 'nod':
      return { ...REST_EMOTE, nod: e * wave };
    case 'squish':
      return { ...REST_EMOTE, compression: 0.28 * e };
    case 'headshake':
      return {
        ...REST_EMOTE,
        headSway: 11 * e * Math.sin(t * Math.PI * 6),
        headTilt: 4 * e * Math.sin(t * Math.PI * 6 - 0.3),
        lookX: 1.5 * e * Math.sin(t * Math.PI * 6),
      };
    case 'bow':
      return {
        ...REST_EMOTE,
        nod: 2.8 * pulse(t),
        compression: 0.12 * pulse(t),
        lookY: 1.5 * e,
      };
    case 'recoil':
      return {
        ...REST_EMOTE,
        headSway: track(t, [
          [0, 0],
          [0.1, -18, 'out'],
          [0.36, -18],
          [0.68, 4, 'out'],
          [0.85, -1.5],
          [1, 0],
        ]),
        headTilt: track(t, [
          [0, 0],
          [0.09, -14, 'out'],
          [0.35, -14],
          [0.7, 4],
          [1, 0],
        ]),
        shake: -4 * pulse(t, 0.22, 0.38),
        compression: 0.09 * pulse(t, 0.24, 0.42),
        lookX: 2 * pulse(t, 0.12, 0.6),
        blinkLeft: 0.7 * pulse(clamp(t / 0.25), 0.24, 0.4),
        blinkRight: 0.7 * pulse(clamp(t / 0.25), 0.24, 0.4),
      };
    case 'puff':
      return { ...REST_EMOTE, puff: pulse(t), compression: -0.06 * e };
    case 'slump':
      return {
        ...REST_EMOTE,
        compression: 0.4 * pulse(t, 0.45, 0.75),
        nod: 0.7 * e,
        lookY: 1.5 * e,
      };
    case 'melt':
      return { ...REST_EMOTE, melt: pulse(t, 0.42, 0.72) };
    case 'pop':
      return {
        ...REST_EMOTE,
        melt: track(t, [
          [0, 0],
          [0.2, 0.82],
          [0.36, 0.82],
          [0.49, 0, 'out'],
          [1, 0],
        ]),
        compression: track(t, [
          [0, 0],
          [0.3, 0.18],
          [0.49, -0.2, 'out'],
          [0.63, 0.17],
          [0.77, -0.07],
          [1, 0],
        ]),
        blinkLeft: pulse(clamp(t / 0.52), 0.35, 0.68),
        blinkRight: pulse(clamp(t / 0.52), 0.35, 0.68),
      };
    case 'jelly':
      return {
        ...REST_EMOTE,
        ripple: pulse(t, 0.12, 0.72),
        ripplePhase: t * Math.PI * 4,
      };
    case 'fall':
      return {
        ...REST_EMOTE,
        roll: track(t, [
          [0, 0],
          [0.16, -12],
          [0.28, 18],
          [0.43, 108, 'in'],
          [0.51, 94, 'out'],
          [0.6, 103, 'in'],
          [0.77, 103],
          [0.94, -4],
          [1, 0],
        ]),
        headTilt: track(t, [
          [0, 0],
          [0.22, -12],
          [0.4, 10],
          [0.6, 0],
          [1, 0],
        ]),
        impact: track(t, [
          [0, 0],
          [0.42, 0],
          [0.46, 0.28, 'out'],
          [0.53, 0],
          [0.61, 0.1],
          [0.72, 0],
          [1, 0],
        ]),
        blinkLeft: pulse(clamp((t - 0.39) / 0.28), 0.16, 0.6),
        blinkRight: pulse(clamp((t - 0.39) / 0.28), 0.16, 0.6),
      };
    case 'land':
      return {
        ...REST_EMOTE,
        roll: track(t, [
          [0, 90],
          [0.12, 103, 'in'],
          [LAND_RECOVERY_START, 103],
          [0.84, -10, 'out'],
          [0.93, 5],
          [1, 0],
        ]),
        impact: track(t, [
          [0, 0],
          [0.025, 0.3, 'out'],
          [0.13, 0],
          [1, 0],
        ]),
        headTilt: track(t, [
          [0, 0],
          [0.35, -8],
          [0.6, -12],
          [0.85, 6],
          [1, 0],
        ]),
      };
    case 'recover':
      return {
        ...REST_EMOTE,
        roll: track(t, [
          [0, 0],
          [0.13, 103],
          [0.21, 103],
          [0.32, 68, 'out'],
          [0.4, 105, 'in'],
          [0.47, 105],
          [0.72, -13, 'out'],
          [0.84, 6],
          [1, 0],
        ]),
        impact: track(t, [
          [0, 0],
          [0.16, 0.15],
          [0.3, 0],
          [0.43, 0.22],
          [0.53, 0],
          [0.76, 0.1],
          [1, 0],
        ]),
        headTilt: track(t, [
          [0, 0],
          [0.26, -9],
          [0.4, 4],
          [0.57, -16],
          [0.78, 7],
          [1, 0],
        ]),
        compression: track(t, [
          [0, 0],
          [0.47, 0.12],
          [0.7, -0.12],
          [0.85, 0.07],
          [1, 0],
        ]),
      };
    case 'dance':
      return {
        ...REST_EMOTE,
        nod: 0.8 * e * wave,
        wave: 7 * e * Math.sin(t * Math.PI * 6),
        compression: 0.09 * e * (1 - Math.cos(t * Math.PI * 8)),
      };
    case 'spin':
      return { ...REST_EMOTE, turn: e };
    case 'peek':
      return { ...REST_EMOTE, nod: 1.4 * pulse(t), lookX: 2 * e, lookY: -e };
    case 'hide':
      return { ...REST_EMOTE, melt: 0.65 * pulse(t), compression: 0.12 * e };
    case 'impatient':
      return {
        ...REST_EMOTE,
        compression: 0.09 * e * (1 - Math.cos(t * Math.PI * 10)),
        lookX: e,
      };
    case 'sulk':
      return {
        ...REST_EMOTE,
        turn: pulse(t),
        hideEyes: clamp((pulse(t) - 0.45) / 0.25),
        nod: -0.4 * e,
      };
    case 'blink':
    case 'slow-blink':
      return {
        ...REST_EMOTE,
        blinkLeft: pulse(t, 0.38, 0.55),
        blinkRight: pulse(t, 0.38, 0.55),
      };
    case 'wink':
      return { ...REST_EMOTE, blinkRight: pulse(t, 0.3, 0.55), nod: 0.2 * e };
    case 'eye-roll': {
      const arc = Math.PI * smooth((t - 0.18) / 0.56);
      const hold = pulse(t, 0.14, 0.76);
      return {
        ...REST_EMOTE,
        lookX: -5.5 * Math.cos(arc) * hold,
        lookY: (-0.7 - 6.3 * Math.sin(arc)) * hold,
        blinkLeft: 0.2 * pulse(t, 0.18, 0.7),
        blinkRight: 0.2 * pulse(t, 0.18, 0.7),
      };
    }
    case 'glance':
      return {
        ...REST_EMOTE,
        lookX: track(t, [
          [0, 0],
          [0.14, -8, 'out'],
          [0.32, -8],
          [0.47, 8, 'out'],
          [0.65, 8],
          [0.8, 0],
          [1, 0],
        ]),
        lookY: track(t, [
          [0, 0],
          [0.32, 0.5],
          [0.47, -1],
          [0.65, -1],
          [0.8, -5],
          [0.88, -5],
          [1, 0],
        ]),
      };
    case 'look-left':
    case 'look-right':
      return {
        ...REST_EMOTE,
        lookX: (kind === 'look-left' ? -7 : 7) * pulse(t, 0.18, 0.76),
      };
    case 'look-up':
    case 'look-down':
      return {
        ...REST_EMOTE,
        lookY: (kind === 'look-up' ? -7 : 6) * pulse(t, 0.18, 0.76),
      };
  }
}

function sample(
  kind: Emote['id'],
  progress: number,
): { pose: typeof REST_EMOTE; look: EmoteLook } {
  if (progress < 0 || progress >= 1 || (progress === 0 && kind !== 'land'))
    return { pose: REST_EMOTE, look: {} };
  const action = EMOTES.find((entry) => entry.id === kind);
  if (!action) return { pose: REST_EMOTE, look: {} };
  if (action.category !== 'reactions')
    return {
      pose: gesturePose(action.id, progress),
      look:
        action.id === 'startle' && progress < 0.78
          ? { expression: 'surprised' }
          : action.id === 'land' &&
              progress > 0 &&
              progress < LAND_RECOVERY_START
            ? { expression: 'pained' }
            : {},
    };
  let time = progress * action.duration;
  for (const step of action.steps as readonly ReactionStep[]) {
    if (time < step.duration)
      return {
        pose: gesturePose(step.gesture, time / step.duration),
        look: { expression: step.expression, extra: step.extra },
      };
    time -= step.duration;
  }
  return { pose: REST_EMOTE, look: {} };
}
export function emotePose(kind: Emote['id'], progress: number) {
  return sample(kind, progress).pose;
}
export function emoteLook(kind: Emote['id'], progress: number) {
  return sample(kind, progress).look;
}
