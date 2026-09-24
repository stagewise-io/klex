import { type ConnectorId, connectorRegistry } from './connector-registry';
import type { KlexBot } from './klex-bot-card';
import type { MascotForm } from './mascot/presets';

/** Illustrative coworkers and identities, not live service connections. */
export const botFixtures = (
  [
    {
      id: 'jonathan',
      name: 'Jonathan',
      role: 'AI Engineer',
      color: '#3e65ff',
      variant: 'classic',
      gesture: 'bob',
    },
    {
      id: 'kristine',
      name: 'Kristine',
      role: 'Product Manager',
      color: '#f99eff',
      variant: 'diamond',
      gesture: 'wobble',
    },
    {
      id: 'monica',
      name: 'Monica',
      role: 'Head of HR',
      color: '#9fbeff',
      variant: 'circle',
      gesture: 'tilt',
    },
    {
      id: 'jeff',
      name: 'Jeff',
      role: 'Quality Assurance',
      color: '#ff9da5',
      variant: 'box',
      gesture: 'blink',
    },
  ] satisfies (Pick<KlexBot, 'id' | 'name' | 'role' | 'gesture'> & {
    color: string;
    variant: MascotForm;
  })[]
).map((person) => ({
  ...person,
  company: 'acme Inc.',
  identity: `${person.id}@acme.inc`,
  integrations: (person.id === 'kristine'
    ? ['google', 'linear', 'slack']
    : ['google', 'github', 'slack']
  ).map((id) => ({
    ...connectorRegistry[id as ConnectorId],
    identity:
      id === 'google'
        ? `${person.id}@acme.inc`
        : id === 'github'
          ? `@${person.id}-acme`
          : `@${person.name} · Acme workspace`,
  })),
}));

export const jonathan = botFixtures[0];
