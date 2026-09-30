import type { BodyShape } from '../../../mascot/presets';
import { capabilityShapes } from '../../../shared/mascot-shapes';
import { heroLooks } from '../../bot-looks';
import type { MovementMode } from '../../klex';

type OfficeMember = {
  id: string;
  name: string;
  role: string;
  work: string;
  position: [number, number, number];
  chairRotation?: number;
  color: string;
  movementMode?: MovementMode;
} & ({ kind: 'human'; side: -1 | 1 } | { kind: 'bot'; shape: BodyShape });

export const officeMembers: OfficeMember[] = [
  {
    id: 'jakob',
    name: 'Jakob',
    role: 'Product Engineer',
    work: 'Perfects the user experience of Klex Bots and the Cloud.',
    position: [-3.05, 1.18, 2.12],
    color: '#899ab2',
    kind: 'human',
    side: -1,
  },
  {
    // An unnamed teammate completes the fourth workstation.
    id: 'office-teammate',
    name: 'Teammate',
    role: 'Team member',
    work: '',
    position: [-3.05, 1.18, -1.72],
    color: '#899ab2',
    kind: 'human',
    side: -1,
  },
  {
    id: 'kristine',
    name: 'Kristine',
    role: 'Product manager · Klex Bot',
    work: 'Turns feedback from Slack and email into scoped Linear issues, checks GitHub for context, and briefs Jonathan on what to build.',
    position: [-5.1, 1.18, -2.95],
    chairRotation: 72.5,
    ...heroLooks.kristine,
    kind: 'bot',
  },
  {
    id: 'glenn',
    name: 'Glenn',
    role: 'CEO',
    work: 'Handles sales, operations, and agent behavior.',
    position: [3.05, 1.18, -1.72],
    color: '#b7aa97',
    kind: 'human',
    side: 1,
  },
  {
    id: 'jonathan',
    name: 'Jonathan',
    role: 'Software Engineer · Klex Bot',
    work: 'Uses Codex on his own work machine to build and validate pull requests. Coordinates with the team in Slack and Linear.',
    position: [-4.8, 0.03, 2.8],
    ...heroLooks.jonathan,
    kind: 'bot',
  },
  {
    id: 'julian',
    name: 'Julian',
    role: 'CTO',
    work: 'Designs the software architecture and leads engineering.',
    position: [3.05, 1.18, 2.12],
    color: '#97aaa0',
    kind: 'human',
    side: 1,
  },
  {
    id: 'harry',
    name: 'Harry',
    role: 'Head of HR · Klex Bot',
    work: 'Reads incoming applications in his own Gmail inbox and flags promising candidates to the team in Slack.',
    position: [5.45, 0.03, 0.6],
    color: '#a7cbb6',
    shape: capabilityShapes.Harry,
    kind: 'bot',
  },
];

export type { OfficeMember };
