import type { BodyShape } from '../mascot';
import {
  capabilityShapes,
  collaborationShapes,
  jonathanLook,
} from '../shared/mascot-shapes';
import type { MovementMode } from './klex/presets';

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
