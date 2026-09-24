export const connectorRegistry = {
  google: {
    id: 'google',
    name: 'Google Workspace',
    logoSrc: '/connectors/google.svg',
    useCase: 'Collaborate in mail, documents, and calendars',
  },
  github: {
    id: 'github',
    name: 'GitHub',
    logoSrc: '/connectors/github.svg',
    useCase: 'Follow issues and review team projects',
  },
  slack: {
    id: 'slack',
    name: 'Slack',
    logoSrc: '/connectors/slack.svg',
    useCase: 'Share progress with the team',
  },
  linear: {
    id: 'linear',
    name: 'Linear',
    logoSrc: '/connectors/linear.svg',
    useCase: 'Plan and assign the next piece of work',
  },
} as const;
export type ConnectorId = keyof typeof connectorRegistry;
export function resolveConnector(id: string | null): ConnectorId {
  return id && Object.hasOwn(connectorRegistry, id)
    ? (id as ConnectorId)
    : 'slack';
}
