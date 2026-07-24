import { describe, expect, it, vi } from 'vitest';

import {
  createAgentId,
  createEnvironmentId,
  createTenantId,
} from '@stagewise/mcp-gateway-core';

import { createGatewayServer } from './gateway-server';

const tenantId = createTenantId('tenant');

function server() {
  return createGatewayServer({
    authorization: { authorize: vi.fn(async () => true) },
    authenticateAgent: async () => ({
      kind: 'agent',
      tenantId,
      agentId: createAgentId('agent'),
    }),
    authenticateEnvironment: async () => undefined,
    parseEnvironmentId: createEnvironmentId,
  });
}

describe('GatewayServer', () => {
  it('starts and closes idempotently', async () => {
    const active = server();
    const first = await active.start();
    const second = await active.start();
    expect(second).toBe(first);
    expect(first.mcpUrl('target').pathname).toBe('/environments/target/mcp');
    expect(first.environmentUrl.protocol).toBe('ws:');
    await active.close();
    await active.close();
  });

  it('allows close before start', async () => {
    const active = server();
    await active.close();
    await active.close();
    await expect(active.start()).rejects.toThrow('closed');
  });
});
