import { describe, expect, it } from 'vitest';

import {
  createAgentId,
  createEnvironmentId,
  createTenantId,
  type GatewayAuthorization,
} from './identity';

describe('identity', () => {
  it.each([
    ['tenant', createTenantId],
    ['agent', createAgentId],
    ['environment', createEnvironmentId],
  ])('creates a valid %s ID', (_name, createId) => {
    expect(createId('example-1')).toBe('example-1');
  });

  it.each([
    ['tenant', createTenantId],
    ['agent', createAgentId],
    ['environment', createEnvironmentId],
  ])('rejects an empty %s ID', (_name, createId) => {
    expect(() => createId('')).toThrow('must not be empty');
  });

  it.each([
    ['tenant', createTenantId],
    ['agent', createAgentId],
    ['environment', createEnvironmentId],
  ])('rejects whitespace around a %s ID', (_name, createId) => {
    expect(() => createId(' example-1 ')).toThrow(
      'must not have leading or trailing whitespace',
    );
  });

  it('supports deployment-provided authorization', async () => {
    const authorization: GatewayAuthorization = {
      authorize: async (agent, environment) =>
        agent.tenantId === environment.tenantId,
    };
    const tenantId = createTenantId('tenant-1');

    await expect(
      authorization.authorize(
        {
          kind: 'agent',
          tenantId,
          agentId: createAgentId('agent-1'),
        },
        {
          kind: 'environment',
          tenantId,
          environmentId: createEnvironmentId('environment-1'),
        },
      ),
    ).resolves.toBe(true);
  });
});
