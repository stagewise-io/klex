import { BODY_SHAPES, type BodyShape, type MovementMode } from '@klex/mascot';

import {
  capabilityShapes,
  collaborationShapes,
  jonathanLook,
} from '../shared/mascot-shapes';

/** The brand-blue Klex used where no team member is meant. */
export const klexLook = {
  color: '#2559fe',
  shape: BODY_SHAPES[0],
  movementMode: 'fly',
} as const;

const catShape = {
  ...collaborationShapes.listener,
  id: 'hero-cat',
  name: 'Cat',
  outline: [
    [30, 65],
    [23, 42],
    [28, 18],
    [44, 16],
    [58, 32],
    [80, 35],
    [102, 32],
    [116, 16],
    [132, 18],
    [137, 42],
    [130, 65],
    [133, 101],
    [116, 121],
    [95, 128],
    [65, 128],
    [44, 121],
    [27, 101],
  ],
} satisfies BodyShape;

export const heroLooks: Record<
  string,
  { color: string; shape: BodyShape; movementMode?: MovementMode }
> = {
  jonathan: {
    ...jonathanLook,
    movementMode: 'fly',
  },
  kristine: { color: '#ffbd91', shape: catShape },
  monica: { color: '#b9a4e3', shape: capabilityShapes.Momo },
  jeff: { color: '#fdfdfc', shape: capabilityShapes.Harry },
};
